/**
 * 文件路径: src/sync/analyzers/vote-relation-analyzer.js
 * 功能概述: SCPPER-CN 用户投票关系分析器模块
 * 
 * 主要功能:
 * - 计算用户之间的投票关系和互动统计
 * - 分析谁给我投票最多（upvote/downvote 分别统计）
 * - 分析我给谁投票最多（投票历史和偏好分析）
 * - 预计算投票关系表，支持快速查询
 * - 投票网络构建和关系强度计算
 * - 用户影响力和投票模式分析
 * 
 * 核心特性:
 * - 基于 fuzzyVoteRecords 的精确投票关系计算
 * - 双向投票关系统计（A->B 和 B->A）
 * - 投票类型分类（upvote, downvote）和统计
 * - 批量关系数据处理和数据库优化
 * - 增量更新机制，避免重复计算
 * 
 * 数据库表:
 * - user_vote_relations: 存储用户间投票关系统计
 */
export class VoteRelationAnalyzer {
  constructor(prisma) {
    this.prisma = prisma;
    this.stats = {
      processedRelations: 0,
      createdRelations: 0,
      updatedRelations: 0,
      errors: []
    };
  }
  
  /**
   * 分析并更新用户投票关系
   */
  async analyzeAndUpdateVoteRelations() {
    console.log('🤝 开始分析用户投票关系...');
    
    try {
      // 1. 清空现有关系表（可选，根据需求决定）
      // await this.clearExistingRelations();
      
      // 2. 从投票记录计算关系
      const relations = await this.calculateVoteRelations();
      
      // 3. 保存到数据库
      await this.saveVoteRelations(relations);
      
      // 4. 生成统计报告
      await this.generateRelationReport();
      
      console.log(`✅ 用户投票关系分析完成: ${this.stats.processedRelations} 个关系`);
      
    } catch (error) {
      console.error(`❌ 投票关系分析失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 从投票记录计算用户关系
   */
  async calculateVoteRelations() {
    console.log('📊 计算用户投票关系...');
    
    // 使用原生SQL查询，性能更好
    const relationQuery = `
      SELECT 
        voter."wikidotId" as from_user_id,
        voter."displayName" as from_user_name,
        author."wikidotId" as to_user_id,
        author."displayName" as to_user_name,
        v.direction,
        COUNT(*) as vote_count
      FROM "VoteRecord" v
      INNER JOIN "User" voter ON v."userWikidotId" = voter."wikidotId"
      INNER JOIN "Page" p ON v."pageId" = p.id
      INNER JOIN "User" author ON p."createdByWikidotId" = author."wikidotId"
      WHERE voter."wikidotId" != author."wikidotId"  -- 排除自投
        AND v.direction != 0
      GROUP BY voter."wikidotId", voter."displayName", author."wikidotId", author."displayName", v.direction
      HAVING COUNT(*) >= 2  -- 只保留至少2次互动的关系
      ORDER BY from_user_id, to_user_id, v.direction
    `;
    
    const rawRelations = await this.prisma.$queryRawUnsafe(relationQuery);
    
    // 将结果转换为关系映射
    const relationMap = new Map();
    
    for (const row of rawRelations) {
      const key = `${row.from_user_id}-${row.to_user_id}`;
      
      if (!relationMap.has(key)) {
        relationMap.set(key, {
          from_user_id: parseInt(row.from_user_id),
          from_user_name: row.from_user_name,
          to_user_id: parseInt(row.to_user_id),
          to_user_name: row.to_user_name,
          upvotes_given: 0,
          downvotes_given: 0,
          total_interactions: 0
        });
      }
      
      const relation = relationMap.get(key);
      const voteCount = parseInt(row.vote_count);
      
      // 修复：确保 direction 为数值类型进行比较
      const direction = parseInt(row.direction) || 0;
      if (direction > 0) {
        relation.upvotes_given = voteCount;
      } else if (direction < 0) {
        relation.downvotes_given = voteCount;
      }
      
      relation.total_interactions += voteCount;
    }
    
    const relations = Array.from(relationMap.values());
    console.log(`   计算完成: ${relations.length} 个用户关系`);
    
    return relations;
  }
  
  /**
   * 保存投票关系到数据库
   */
  async saveVoteRelations(relations) {
    console.log('💾 保存用户投票关系...');
    
    // 首先确保用户投票关系表存在
    await this.ensureVoteRelationTable();
    
    const batchSize = 100;
    
    for (let i = 0; i < relations.length; i += batchSize) {
      const batch = relations.slice(i, i + batchSize);
      
      try {
        // 使用 Prisma upsert 操作，避免 SQL 注入风险
        const upsertPromises = batch.map(relation => 
          this.prisma.$executeRaw`
            INSERT INTO user_vote_relations (
              from_user_id, to_user_id, from_user_name, to_user_name,
              upvotes_given, downvotes_given, total_interactions, last_updated
            ) VALUES (
              ${relation.from_user_id}, ${relation.to_user_id}, ${relation.from_user_name}, 
              ${relation.to_user_name}, ${relation.upvotes_given}, ${relation.downvotes_given}, 
              ${relation.total_interactions}, NOW()
            )
            ON CONFLICT (from_user_id, to_user_id) 
            DO UPDATE SET
              from_user_name = EXCLUDED.from_user_name,
              to_user_name = EXCLUDED.to_user_name,
              upvotes_given = EXCLUDED.upvotes_given,
              downvotes_given = EXCLUDED.downvotes_given,
              total_interactions = EXCLUDED.total_interactions,
              last_updated = NOW()
          `
        );
        
        await Promise.all(upsertPromises);
        
        this.stats.processedRelations += batch.length;
        
        if (this.stats.processedRelations % 500 === 0) {
          console.log(`   已处理 ${this.stats.processedRelations}/${relations.length} 个关系...`);
        }
        
      } catch (error) {
        console.error(`❌ 批次保存失败 (${i}-${i + batch.length}): ${error.message}`);
        this.stats.errors.push({
          type: 'batch_save_error',
          batch: { start: i, end: i + batch.length },
          error: error.message
        });
      }
    }
    
    console.log(`✅ 投票关系保存完成: ${this.stats.processedRelations} 个`);
  }
  
  /**
   * 确保用户投票关系表存在
   */
  async ensureVoteRelationTable() {
    try {
      // 尝试创建表（如果不存在）
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_vote_relations (
          id SERIAL PRIMARY KEY,
          from_user_id INTEGER NOT NULL,
          to_user_id INTEGER NOT NULL,
          from_user_name VARCHAR(255),
          to_user_name VARCHAR(255),
          upvotes_given INTEGER DEFAULT 0,
          downvotes_given INTEGER DEFAULT 0,
          total_interactions INTEGER DEFAULT 0,
          last_updated TIMESTAMP DEFAULT NOW(),
          UNIQUE(from_user_id, to_user_id)
        )
      `);
      
      // 创建索引
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_vote_relations_from_user 
        ON user_vote_relations(from_user_id)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_vote_relations_to_user 
        ON user_vote_relations(to_user_id)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_vote_relations_interactions 
        ON user_vote_relations(total_interactions DESC)
      `);
      
    } catch (error) {
      // 表可能已存在，忽略错误
      console.log(`   表创建信息: ${error.message}`);
    }
  }
  
  /**
   * 生成投票关系统计报告
   */
  async generateRelationReport() {
    console.log('\n📈 生成投票关系统计报告...');
    
    try {
      // 1. 总体统计
      const totalRelations = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as total FROM user_vote_relations
      `);
      
      // 2. 最活跃的投票者（给出最多投票）
      const topVoters = await this.prisma.$queryRawUnsafe(`
        SELECT 
          from_user_name,
          SUM(total_interactions) as total_votes_given,
          SUM(upvotes_given) as upvotes_given,
          SUM(downvotes_given) as downvotes_given,
          COUNT(*) as relationships
        FROM user_vote_relations 
        GROUP BY from_user_id, from_user_name
        ORDER BY total_votes_given DESC 
        LIMIT 10
      `);
      
      // 3. 最受欢迎的作者（收到最多投票）
      const topReceivers = await this.prisma.$queryRawUnsafe(`
        SELECT 
          to_user_name,
          SUM(total_interactions) as total_votes_received,
          SUM(upvotes_given) as upvotes_received,
          SUM(downvotes_given) as downvotes_received,
          COUNT(*) as voters
        FROM user_vote_relations 
        GROUP BY to_user_id, to_user_name
        ORDER BY total_votes_received DESC 
        LIMIT 10
      `);
      
      // 4. 最强的支持关系（upvote最多）
      const strongestSupport = await this.prisma.$queryRawUnsafe(`
        SELECT 
          from_user_name as voter,
          to_user_name as author,
          upvotes_given,
          total_interactions
        FROM user_vote_relations 
        WHERE upvotes_given > 0
        ORDER BY upvotes_given DESC 
        LIMIT 10
      `);
      
      // 5. 双向投票关系
      const mutualVoting = await this.prisma.$queryRawUnsafe(`
        SELECT 
          r1.from_user_name as user1,
          r1.to_user_name as user2,
          r1.upvotes_given as user1_to_user2_up,
          r1.downvotes_given as user1_to_user2_down,
          r2.upvotes_given as user2_to_user1_up,
          r2.downvotes_given as user2_to_user1_down
        FROM user_vote_relations r1
        INNER JOIN user_vote_relations r2 
          ON r1.from_user_id = r2.to_user_id 
          AND r1.to_user_id = r2.from_user_id
        WHERE r1.from_user_id < r1.to_user_id  -- 避免重复
        ORDER BY (r1.total_interactions + r2.total_interactions) DESC
        LIMIT 10
      `);
      
      // 打印报告
      console.log('\n📊 用户投票关系统计报告');
      console.log('='.repeat(80));
      console.log(`📈 总投票关系数: ${totalRelations[0]?.total || 0}`);
      
      console.log('\n🏆 最活跃投票者 (Top 10):');
      topVoters.forEach((voter, i) => {
        console.log(`   ${i + 1}. ${voter.from_user_name}: ${voter.total_votes_given}票 (↑${voter.upvotes_given} ↓${voter.downvotes_given}, 涉及${voter.relationships}人)`);
      });
      
      console.log('\n⭐ 最受欢迎作者 (Top 10):');
      topReceivers.forEach((author, i) => {
        console.log(`   ${i + 1}. ${author.to_user_name}: ${author.total_votes_received}票 (↑${author.upvotes_received} ↓${author.downvotes_received}, 来自${author.voters}人)`);
      });
      
      console.log('\n💪 最强支持关系 (Top 10):');
      strongestSupport.forEach((relation, i) => {
        console.log(`   ${i + 1}. ${relation.voter} → ${relation.author}: ${relation.upvotes_given}个upvote (总计${relation.total_interactions}票)`);
      });
      
      console.log('\n🤝 双向投票关系 (Top 10):');
      mutualVoting.forEach((mutual, i) => {
        console.log(`   ${i + 1}. ${mutual.user1} ⇄ ${mutual.user2}:`);
        console.log(`      ${mutual.user1} → ${mutual.user2}: ↑${mutual.user1_to_user2_up} ↓${mutual.user1_to_user2_down}`);
        console.log(`      ${mutual.user2} → ${mutual.user1}: ↑${mutual.user2_to_user1_up} ↓${mutual.user2_to_user1_down}`);
      });
      
    } catch (error) {
      console.error(`❌ 生成统计报告失败: ${error.message}`);
    }
  }
  
  /**
   * 查询特定用户的投票关系
   */
  async getUserVoteRelations(userId, type = 'both') {
    try {
      let results = {};
      
      if (type === 'given' || type === 'both') {
        // 查询该用户给别人的投票
        results.given = await this.prisma.$queryRawUnsafe(`
          SELECT 
            to_user_name as target_user,
            upvotes_given,
            downvotes_given,
            total_interactions
          FROM user_vote_relations 
          WHERE from_user_id = $1
          ORDER BY total_interactions DESC
        `, userId);
      }
      
      if (type === 'received' || type === 'both') {
        // 查询别人给该用户的投票
        results.received = await this.prisma.$queryRawUnsafe(`
          SELECT 
            from_user_name as voter,
            upvotes_given,
            downvotes_given,
            total_interactions
          FROM user_vote_relations 
          WHERE to_user_id = $1
          ORDER BY total_interactions DESC
        `, userId);
      }
      
      return results;
      
    } catch (error) {
      console.error(`❌ 查询用户投票关系失败: ${error.message}`);
      return null;
    }
  }
  
  /**
   * 清空现有关系数据（谨慎使用）
   */
  async clearExistingRelations() {
    console.log('🗑️  清空现有投票关系数据...');
    
    try {
      await this.prisma.$executeRawUnsafe('TRUNCATE TABLE user_vote_relations');
      console.log('✅ 现有关系数据已清空');
    } catch (error) {
      console.log(`   清空操作信息: ${error.message}`);
    }
  }
}