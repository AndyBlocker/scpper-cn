-- 搜索索引增强 - 数据库结构升级脚本
-- 为SearchIndex表添加预计算搜索向量和随机选句功能

BEGIN;

-- 1. 添加新字段到SearchIndex表
ALTER TABLE "SearchIndex" ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE "SearchIndex" ADD COLUMN IF NOT EXISTS random_sentences text[];
ALTER TABLE "SearchIndex" ADD COLUMN IF NOT EXISTS content_stats jsonb;

-- 2. 创建计算搜索向量的函数 (处理超长单词)
CREATE OR REPLACE FUNCTION calculate_search_vector_enhanced(
  title text,
  text_content text, 
  source_content text
) RETURNS tsvector AS $$
DECLARE
  clean_title text;
  clean_content text;
  clean_source text;
BEGIN
  -- 清理超长单词：将超过1000字符的连续字符串截断
  clean_title := regexp_replace(COALESCE(title, ''), '\S{1000,}', '', 'g');
  clean_content := regexp_replace(COALESCE(text_content, ''), '\S{1000,}', '', 'g');
  clean_source := regexp_replace(COALESCE(source_content, ''), '\S{1000,}', '', 'g');
  
  -- 进一步清理：移除可能的HTML标签、URL等
  clean_content := regexp_replace(clean_content, '<[^>]*>', ' ', 'g');
  clean_content := regexp_replace(clean_content, 'https?://\S+', ' ', 'g');
  clean_source := regexp_replace(clean_source, '<[^>]*>', ' ', 'g');
  
  RETURN to_tsvector('english', clean_title) || 
         to_tsvector('english', clean_content) ||
         to_tsvector('english', clean_source);
EXCEPTION
  WHEN OTHERS THEN
    -- 如果仍然出错，返回仅标题的向量
    RETURN to_tsvector('english', COALESCE(title, ''));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. 创建内容统计计算函数
CREATE OR REPLACE FUNCTION calculate_content_stats_enhanced(
  title text,
  text_content text,
  source_content text
) RETURNS jsonb AS $$
DECLARE
  title_len int := COALESCE(length(title), 0);
  content_len int := COALESCE(length(text_content), 0);
  source_len int := COALESCE(length(source_content), 0);
  total_text text := COALESCE(title, '') || ' ' || COALESCE(text_content, '') || ' ' || COALESCE(source_content, '');
  word_count int;
  sentence_count int;
  paragraph_count int;
BEGIN
  -- 计算单词数 (简单空格分割)
  word_count := array_length(string_to_array(trim(total_text), ' '), 1);
  
  -- 计算句子数 (基于常见标点)
  sentence_count := (
    length(text_content) - length(replace(replace(replace(replace(replace(text_content, '。', ''), '！', ''), '？', ''), '.', ''), '!', ''))
  );
  
  -- 计算段落数
  paragraph_count := array_length(string_to_array(COALESCE(text_content, ''), E'\n'), 1);
  
  RETURN jsonb_build_object(
    'titleLength', title_len,
    'contentLength', content_len,
    'sourceLength', source_len,
    'totalLength', title_len + content_len + source_len,
    'wordCount', COALESCE(word_count, 0),
    'sentenceCount', GREATEST(sentence_count, 0),
    'paragraphCount', GREATEST(paragraph_count, 1),
    'lastCalculated', now()
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 4. 创建提取随机句子的函数 (简化版，主要逻辑在Node.js中)
CREATE OR REPLACE FUNCTION extract_sample_sentences(content text, max_sentences int DEFAULT 3)
RETURNS text[] AS $$
DECLARE
  clean_content text;
  sentences text[];
  sentence text;
  result text[] := '{}';
  i int;
  sentence_count int;
BEGIN
  IF content IS NULL OR length(trim(content)) = 0 THEN
    RETURN result;
  END IF;
  
  -- 清理内容：移除超长字符串、HTML标签等
  clean_content := regexp_replace(content, '\S{500,}', '', 'g');
  clean_content := regexp_replace(clean_content, '<[^>]*>', ' ', 'g');
  clean_content := regexp_replace(clean_content, 'https?://\S+', ' ', 'g');
  
  -- 限制总长度避免处理过大的文本
  IF length(clean_content) > 50000 THEN
    clean_content := left(clean_content, 50000);
  END IF;
  
  -- 简单的句子分割 (基于句号、感叹号、问号)
  sentences := regexp_split_to_array(clean_content, '[。！？.!?]+');
  sentence_count := array_length(sentences, 1);
  
  -- 过滤空句子和过短/过长句子
  FOR i IN 1..COALESCE(sentence_count, 0) LOOP
    sentence := trim(sentences[i]);
    IF length(sentence) > 10 AND length(sentence) < 200 THEN
      result := result || sentence;
      -- 限制数量
      IF array_length(result, 1) >= max_sentences THEN
        EXIT;
      END IF;
    END IF;
  END LOOP;
  
  RETURN result;
EXCEPTION
  WHEN OTHERS THEN
    -- 出错时返回空数组
    RETURN '{}';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;

-- 5. 在事务外创建索引 (避免锁表)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_vector_enhanced_gin 
ON "SearchIndex" USING gin(search_vector);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_random_sentences_gin 
ON "SearchIndex" USING gin(random_sentences);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_stats_gin 
ON "SearchIndex" USING gin(content_stats);

-- 6. 为现有数据预计算新字段 (分批处理，避免长时间锁定)
DO $$
DECLARE
  batch_size INTEGER := 500; -- 减少批次大小
  total_count INTEGER;
  processed INTEGER := 0;
  current_batch INTEGER;
  error_count INTEGER := 0;
  start_time timestamp;
BEGIN
  start_time := clock_timestamp();
  
  -- 获取需要更新的总数
  SELECT COUNT(*) INTO total_count 
  FROM "SearchIndex" 
  WHERE search_vector IS NULL OR random_sentences IS NULL OR content_stats IS NULL;
  
  RAISE NOTICE '开始更新现有搜索索引数据，总计 % 条记录', total_count;
  
  IF total_count = 0 THEN
    RAISE NOTICE '✅ 所有记录已经增强，无需更新';
    RETURN;
  END IF;
  
  WHILE processed < total_count LOOP
    BEGIN
      -- 分批更新 (使用异常处理)
      UPDATE "SearchIndex" 
      SET 
        search_vector = calculate_search_vector_enhanced(title, text_content, source_content),
        content_stats = calculate_content_stats_enhanced(title, text_content, source_content),
        random_sentences = extract_sample_sentences(text_content, 4)
      WHERE "pageId" IN (
        SELECT "pageId" 
        FROM "SearchIndex" 
        WHERE search_vector IS NULL OR random_sentences IS NULL OR content_stats IS NULL
        LIMIT batch_size
      );
      
      GET DIAGNOSTICS current_batch = ROW_COUNT;
      processed := processed + current_batch;
      
      -- 每1000条记录显示一次进度
      IF processed % 1000 = 0 OR current_batch = 0 THEN
        RAISE NOTICE '已更新 %/% 条记录 (%.1f%%) - 错误: %', 
          processed, total_count, (processed::float / NULLIF(total_count, 0) * 100), error_count;
      END IF;
      
      -- 如果没有更多记录要更新，退出循环
      IF current_batch = 0 THEN
        EXIT;
      END IF;
      
    EXCEPTION
      WHEN OTHERS THEN
        error_count := error_count + 1;
        RAISE WARNING '批次更新失败 (第% 批): %', (processed / batch_size + 1), SQLERRM;
        
        -- 如果错误太多，停止处理
        IF error_count > 10 THEN
          RAISE EXCEPTION '错误太多，停止批量更新';
        END IF;
        
        -- 跳过这个批次
        processed := processed + batch_size;
    END;
    
    -- 短暂暂停，减少数据库负载
    PERFORM pg_sleep(0.1);
  END LOOP;
  
  RAISE NOTICE '✅ 搜索索引增强完成！已更新 % 条记录，耗时 %', 
    processed, (clock_timestamp() - start_time);
    
  IF error_count > 0 THEN
    RAISE NOTICE '⚠️  处理过程中遇到 % 个批次错误，可能需要手动检查', error_count;
  END IF;
END $$;

-- 7. 分析表以更新统计信息
ANALYZE "SearchIndex";

-- 8. 显示完成状态
DO $$
DECLARE
  enhanced_count INTEGER;
  total_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_count FROM "SearchIndex";
  SELECT COUNT(*) INTO enhanced_count FROM "SearchIndex" 
  WHERE search_vector IS NOT NULL AND random_sentences IS NOT NULL AND content_stats IS NOT NULL;
  
  RAISE NOTICE '';
  RAISE NOTICE '🎉 搜索索引增强完成！';
  RAISE NOTICE '📊 统计信息:';
  RAISE NOTICE '   - 总记录数: %', total_count;
  RAISE NOTICE '   - 已增强记录: %', enhanced_count;
  RAISE NOTICE '   - 增强比例: %.1f%%', (enhanced_count::float / NULLIF(total_count, 0) * 100);
  RAISE NOTICE '';
  RAISE NOTICE '🚀 新功能:';
  RAISE NOTICE '   ✅ 预计算搜索向量 (search_vector)';
  RAISE NOTICE '   ✅ 随机句子提取 (random_sentences)'; 
  RAISE NOTICE '   ✅ 内容统计信息 (content_stats)';
  RAISE NOTICE '';
  RAISE NOTICE '📋 下一步: 部署backend代码更新以使用新字段';
END $$;