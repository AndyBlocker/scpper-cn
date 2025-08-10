import crypto from 'crypto';

/**
 * 文本处理工具类
 * 为搜索索引提供预计算功能：搜索向量、随机句子提取、内容统计
 */
export class TextProcessor {
  
  /**
   * 计算搜索向量的SQL表达式
   * @param title 标题
   * @param textContent 正文内容
   * @param sourceContent 源代码内容
   * @returns PostgreSQL tsvector 表达式
   */
  static buildSearchVectorExpression(title?: string, textContent?: string, sourceContent?: string): string {
    // 转义单引号，防止SQL注入
    const escapeText = (text: string) => text.replace(/'/g, "''").replace(/\\/g, '\\\\');
    
    const titlePart = title ? `to_tsvector('english', '${escapeText(title)}')` : `to_tsvector('english', '')`;
    const contentPart = textContent ? `to_tsvector('english', '${escapeText(textContent)}')` : `to_tsvector('english', '')`;
    const sourcePart = sourceContent ? `to_tsvector('english', '${escapeText(sourceContent)}')` : `to_tsvector('english', '')`;
    
    return `(${titlePart} || ${contentPart} || ${sourcePart})`;
  }

  /**
   * 智能提取代表性句子
   * @param text 原始文本
   * @param maxSentences 最大句子数量
   * @returns 提取的句子数组
   */
  static extractRandomSentences(text: string, maxSentences = 4): string[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    // 清理文本 - 处理超长单词和特殊内容
    let cleanText = text
      .replace(/\S{500,}/g, '') // 移除超过500字符的连续字符串
      .replace(/<[^>]*>/g, ' ') // 移除HTML标签
      .replace(/https?:\/\/\S+/g, ' ') // 移除URL
      .replace(/\n+/g, ' ')  // 换行转空格
      .replace(/\s+/g, ' ')  // 多空格转单空格
      .trim();

    // 限制总长度，避免处理超大文本
    if (cleanText.length > 10000) {
      cleanText = cleanText.substring(0, 10000);
    }

    // 多语言句子分割 (支持中英文标点)
    const sentences = cleanText
      .replace(/([。！？!?.])\s*/g, '$1|SPLIT|')  // 标记分割点
      .split('|SPLIT|')
      .map(s => s.trim())
      .filter(s => {
        // 过滤规则：长度适中、不是纯数字/符号、包含实际内容
        return s.length >= 10 && 
               s.length <= 300 && 
               /[a-zA-Z\u4e00-\u9fa5]/.test(s) && // 包含字母或中文
               !s.match(/^[\d\s\-_=+*/.,:;'"()[\]{}]*$/); // 不是纯符号
      });

    if (sentences.length === 0) {
      return [];
    }

    if (sentences.length <= maxSentences) {
      return sentences;
    }

    // 智能选择策略
    const result: string[] = [];
    const used = new Set<number>();

    // 1. 优先选择开头句（通常是概述）
    if (sentences.length > 0) {
      result.push(sentences[0]);
      used.add(0);
    }

    // 2. 选择结尾句（如果有足够句子且与开头不同）
    if (sentences.length > 2 && result.length < maxSentences) {
      const lastIndex = sentences.length - 1;
      if (!used.has(lastIndex) && sentences[lastIndex] !== sentences[0]) {
        result.push(sentences[lastIndex]);
        used.add(lastIndex);
      }
    }

    // 3. 从中间随机选择剩余句子
    const remaining = maxSentences - result.length;
    const availableIndices = sentences
      .map((_, index) => index)
      .filter(index => !used.has(index));

    // 随机打乱并选择
    for (let i = availableIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [availableIndices[i], availableIndices[j]] = [availableIndices[j], availableIndices[i]];
    }

    for (let i = 0; i < Math.min(remaining, availableIndices.length); i++) {
      result.push(sentences[availableIndices[i]]);
    }

    // 按原文顺序排序（可选）
    result.sort((a, b) => {
      const indexA = sentences.indexOf(a);
      const indexB = sentences.indexOf(b);
      return indexA - indexB;
    });

    return result;
  }

  /**
   * 计算内容统计信息
   * @param title 标题
   * @param textContent 正文内容  
   * @param sourceContent 源代码内容
   * @returns 统计信息对象
   */
  static calculateContentStats(title?: string, textContent?: string, sourceContent?: string) {
    const stats = {
      // 基础长度统计
      titleLength: title?.length || 0,
      contentLength: textContent?.length || 0,
      sourceLength: sourceContent?.length || 0,
      totalLength: (title?.length || 0) + (textContent?.length || 0) + (sourceContent?.length || 0),

      // 单词统计
      titleWords: this.countWords(title || ''),
      contentWords: this.countWords(textContent || ''),
      sourceWords: this.countWords(sourceContent || ''),
      totalWords: 0,

      // 句子和段落统计
      contentSentences: this.countSentences(textContent || ''),
      contentParagraphs: this.countParagraphs(textContent || ''),

      // 内容质量指标
      readabilityScore: this.calculateReadabilityScore(textContent || ''),
      avgWordsPerSentence: 0,
      avgSentencesPerParagraph: 0,

      // 内容类型分析
      hasChineseContent: this.hasChineseCharacters(textContent || ''),
      hasEnglishContent: this.hasEnglishWords(textContent || ''),
      hasCodeContent: this.hasCodePatterns(sourceContent || ''),

      // 时间戳
      calculatedAt: new Date().toISOString()
    };

    // 计算总词数
    stats.totalWords = stats.titleWords + stats.contentWords + stats.sourceWords;

    // 计算平均值
    stats.avgWordsPerSentence = stats.contentSentences > 0 ? 
      Math.round(stats.contentWords / stats.contentSentences * 10) / 10 : 0;
    
    stats.avgSentencesPerParagraph = stats.contentParagraphs > 0 ? 
      Math.round(stats.contentSentences / stats.contentParagraphs * 10) / 10 : 0;

    return stats;
  }

  /**
   * 生成内容摘要
   * @param title 标题
   * @param textContent 正文内容
   * @param maxLength 最大长度
   * @returns 内容摘要
   */
  static generateContentSummary(title?: string, textContent?: string, maxLength = 200): string {
    const randomSentences = this.extractRandomSentences(textContent || '', 2);
    
    if (randomSentences.length === 0) {
      return title ? `${title.substring(0, maxLength)}...` : '';
    }

    const summary = randomSentences.join(' ');
    
    if (summary.length <= maxLength) {
      return summary;
    }

    return summary.substring(0, maxLength - 3) + '...';
  }

  /**
   * 创建搜索关键词
   * @param title 标题
   * @param textContent 正文内容
   * @returns 关键词数组
   */
  static extractKeywords(title?: string, textContent?: string): string[] {
    const text = (title || '') + ' ' + (textContent || '');
    
    // 简单的关键词提取（基于词频）
    const words = text
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ') // 保留中英文数字
      .split(/\s+/)
      .filter(word => word.length >= 2); // 过滤过短词汇

    // 统计词频
    const wordCount = new Map<string, number>();
    words.forEach(word => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });

    // 按词频排序，返回前10个
    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  // 辅助方法

  private static countWords(text: string): number {
    if (!text.trim()) return 0;
    
    // 中英文混合词数统计
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const numbers = (text.match(/\d+/g) || []).length;
    
    return chineseChars + englishWords + numbers;
  }

  private static countSentences(text: string): number {
    if (!text.trim()) return 0;
    
    return (text.match(/[。！？!?.]/g) || []).length || 1;
  }

  private static countParagraphs(text: string): number {
    if (!text.trim()) return 0;
    
    return text.split(/\n\s*\n/).filter(para => para.trim().length > 0).length || 1;
  }

  private static calculateReadabilityScore(text: string): number {
    if (!text.trim()) return 0;
    
    const sentences = this.countSentences(text);
    const words = this.countWords(text);
    const avgWordsPerSentence = sentences > 0 ? words / sentences : 0;
    
    // 简化的可读性分数 (基于句子长度)
    if (avgWordsPerSentence < 10) return 0.9;
    if (avgWordsPerSentence < 20) return 0.7;
    if (avgWordsPerSentence < 30) return 0.5;
    return 0.3;
  }

  private static hasChineseCharacters(text: string): boolean {
    return /[\u4e00-\u9fa5]/.test(text);
  }

  private static hasEnglishWords(text: string): boolean {
    return /[a-zA-Z]/.test(text);
  }

  private static hasCodePatterns(text: string): boolean {
    // 检测代码模式：函数调用、变量声明、HTML标签等
    const codePatterns = [
      /\w+\s*\([^)]*\)/, // 函数调用
      /<\w+[^>]*>/,      // HTML标签
      /\w+\s*[=:]\s*\w+/, // 赋值
      /\/\*[\s\S]*?\*\//, // 注释
      /\/\/.*$/m,        // 单行注释
    ];
    
    return codePatterns.some(pattern => pattern.test(text));
  }

  /**
   * 生成内容指纹 (用于检测重复内容)
   * @param text 文本内容
   * @returns MD5 指纹
   */
  static generateContentFingerprint(text: string): string {
    // 标准化文本：去除空白、标点、转小写
    const normalized = text
      .replace(/\s+/g, ' ')
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '')
      .toLowerCase()
      .trim();
    
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * 检测文本语言
   * @param text 文本内容
   * @returns 语言标识
   */
  static detectLanguage(text: string): 'zh' | 'en' | 'mixed' | 'unknown' {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
    const totalChars = chineseChars + englishChars;
    
    if (totalChars === 0) return 'unknown';
    
    const chineseRatio = chineseChars / totalChars;
    
    if (chineseRatio > 0.7) return 'zh';
    if (chineseRatio < 0.3) return 'en';
    return 'mixed';
  }
}