#!/usr/bin/env ts-node

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function checkDataAggregation() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    // 检查每天的投票数量，找出异常聚集的日期
    const sql = `
      WITH daily_votes AS (
        SELECT 
          DATE(timestamp) as vote_date,
          COUNT(*) as vote_count
        FROM "Vote"
        WHERE timestamp >= '2022-01-01' AND timestamp <= '2023-01-01'
        GROUP BY DATE(timestamp)
        ORDER BY vote_count DESC
      ),
      stats AS (
        SELECT 
          AVG(vote_count) as avg_votes,
          STDDEV(vote_count) as stddev_votes,
          MAX(vote_count) as max_votes
        FROM daily_votes
      )
      SELECT 
        dv.vote_date,
        dv.vote_count,
        s.avg_votes,
        s.stddev_votes,
        CASE 
          WHEN dv.vote_count > s.avg_votes + (3 * s.stddev_votes) 
          THEN 'ANOMALY'
          ELSE 'NORMAL'
        END as status
      FROM daily_votes dv
      CROSS JOIN stats s
      WHERE dv.vote_count > s.avg_votes + (2 * s.stddev_votes)
      ORDER BY dv.vote_date;
    `;

    const { rows } = await pool.query(sql);
    
    console.log('=== 数据聚集检测结果 ===\n');
    console.log('检测到以下日期存在异常数据聚集：\n');
    
    const anomalyDates = rows.filter(r => r.status === 'ANOMALY');
    
    if (anomalyDates.length > 0) {
      console.log('严重聚集（超过3倍标准差）：');
      anomalyDates.forEach(row => {
        const date = new Date(row.vote_date);
        console.log(`  ${date.toISOString().split('T')[0]}: ${row.vote_count} 票 (平均: ${Math.round(row.avg_votes)} 票)`);
      });
    }
    
    console.log('\n中度聚集（超过2倍标准差）：');
    rows.filter(r => r.status === 'NORMAL').forEach(row => {
      const date = new Date(row.vote_date);
      console.log(`  ${date.toISOString().split('T')[0]}: ${row.vote_count} 票`);
    });

    // 找出聚集的月份
    const monthlyAggregation = new Map<string, number>();
    rows.forEach(row => {
      const date = new Date(row.vote_date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      monthlyAggregation.set(monthKey, (monthlyAggregation.get(monthKey) || 0) + Number(row.vote_count));
    });

    console.log('\n=== 月度聚集统计 ===\n');
    Array.from(monthlyAggregation.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([month, count]) => {
        console.log(`  ${month}: ${count} 票`);
      });

    // 建议的聚集日期范围
    if (anomalyDates.length > 0) {
      const firstAnomaly = new Date(anomalyDates[0].vote_date);
      const lastAnomaly = new Date(anomalyDates[anomalyDates.length - 1].vote_date);
      
      console.log('\n=== 建议 ===');
      console.log(`建议将 ${firstAnomaly.toISOString().split('T')[0]} 到 ${lastAnomaly.toISOString().split('T')[0]} 标记为数据聚集期`);
      console.log('在此期间只显示累计评分线，不显示投票柱状图');
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkDataAggregation();
