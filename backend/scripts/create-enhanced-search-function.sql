-- 创建增强搜索向量计算函数
-- 这个函数被 IncrementalAnalyzeJob.ts 中的搜索索引更新逻辑调用

CREATE OR REPLACE FUNCTION calculate_search_vector_enhanced(
    title_text TEXT DEFAULT '',
    content_text TEXT DEFAULT '', 
    source_text TEXT DEFAULT ''
) RETURNS tsvector AS $$
BEGIN
    -- 处理 NULL 值
    title_text := COALESCE(title_text, '');
    content_text := COALESCE(content_text, '');
    source_text := COALESCE(source_text, '');
    
    -- 创建加权的搜索向量
    -- 标题权重最高 (A), 内容次之 (B), 源代码最低 (C)
    RETURN 
        setweight(to_tsvector('english', title_text), 'A') ||
        setweight(to_tsvector('english', content_text), 'B') ||
        setweight(to_tsvector('english', source_text), 'C');
END;
$$ LANGUAGE plpgsql IMMUTABLE;