/**
 * 文件路径: src/sync/core/checkpoint-manager.js
 * 功能概述: SCPPER-CN 断点续传管理器模块
 * 
 * 主要功能:
 * - 页面同步过程的断点保存和恢复
 * - 投票记录同步的断点续传管理
 * - 大规模数据同步的中断恢复支持
 * - 检查点文件的创建、加载和清理
 * - 同步进度的持久化存储
 * - 错误恢复和状态还原机制
 * 
 * 核心特性:
 * - 自动检查点保存（基于处理数量阈值）
 * - 智能检查点加载（选择最新可用检查点）
 * - 多类型检查点支持（页面、投票、用户等）
 * - 检查点文件管理和清理机制
 * - 时间戳标记和版本控制
 * 
 * 使用场景:
 * - 长时间运行的数据同步任务
 * - 网络不稳定环境下的可靠同步
 * - 大数据量处理的进度保护
 */

import fs from 'fs';
import path from 'path';
export class CheckpointManager {
  constructor(checkpointDir) {
    this.checkpointDir = checkpointDir;
  }
  
  /**
   * 保存页面同步检查点
   */
  async savePageCheckpoint(checkpoint) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const filename = `page-checkpoint-${checkpoint.pagesProcessed}-${timestamp}.json`;
    const filePath = path.join(this.checkpointDir, filename);
    const tempPath = `${filePath}.tmp`;
    
    try {
      // 先写入临时文件，然后原子性重命名，避免并发写入问题
      await fs.promises.writeFile(tempPath, JSON.stringify(checkpoint, null, 2));
      await fs.promises.rename(tempPath, filePath);
      console.log(`💾 页面检查点已保存: ${filename}`);
      return filePath;
    } catch (error) {
      // 清理临时文件
      try {
        await fs.promises.unlink(tempPath);
      } catch {}
      throw error;
    }
  }
  
  /**
   * 加载页面同步检查点
   */
  async loadPageCheckpoint() {
    const files = fs.readdirSync(this.checkpointDir)
      .filter(file => file.startsWith('page-checkpoint-') && file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(this.checkpointDir, file),
        mtime: fs.statSync(path.join(this.checkpointDir, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    if (files.length === 0) {
      return null;
    }
    
    // 尝试加载最新的检查点，如果损坏则回退到次新的
    for (const file of files) {
      try {
        console.log(`🔄 尝试加载检查点文件: ${file.name}`);
        const rawData = await fs.promises.readFile(file.path, 'utf8');
        const checkpoint = JSON.parse(rawData);
        
        // 基本完整性检查
        if (checkpoint && typeof checkpoint.pagesProcessed === 'number') {
          console.log(`✅ 成功加载检查点: ${file.name}`);
          return checkpoint;
        } else {
          console.log(`⚠️  检查点数据不完整: ${file.name}`);
        }
      } catch (error) {
        console.log(`⚠️  检查点文件损坏: ${file.name} - ${error.message}`);
        // 继续尝试下一个文件
      }
    }
    
    console.log('❌ 所有检查点文件都无法加载');
    return null;
  }
  
  /**
   * 保存投票同步检查点
   */
  async saveVoteCheckpoint(checkpoint) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const filename = `vote-progress-checkpoint-${timestamp}.json`;
    const filePath = path.join(this.checkpointDir, filename);
    const tempPath = `${filePath}.tmp`;
    
    try {
      // 转换Set为Array以便JSON序列化
      const serializableCheckpoint = {
        ...checkpoint,
        completedPages: Array.from(checkpoint.completedPages || []),
        partialPages: checkpoint.partialPages ? 
          Object.fromEntries(checkpoint.partialPages) : {}
      };
      
      // 原子性写入
      await fs.promises.writeFile(tempPath, JSON.stringify(serializableCheckpoint, null, 2));
      await fs.promises.rename(tempPath, filePath);
      console.log(`💾 投票检查点已保存: ${filename}`);
      return filePath;
    } catch (error) {
      // 清理临时文件
      try {
        await fs.promises.unlink(tempPath);
      } catch {}
      throw error;
    }
  }
  
  /**
   * 加载投票同步检查点
   */
  async loadVoteCheckpoint() {
    const files = fs.readdirSync(this.checkpointDir)
      .filter(file => file.startsWith('vote-progress-checkpoint-') && file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(this.checkpointDir, file),
        mtime: fs.statSync(path.join(this.checkpointDir, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    if (files.length === 0) {
      return null;
    }
    
    const latestFile = files[0];
    console.log(`🔄 发现投票检查点文件: ${latestFile.name}`);
    
    const rawData = await fs.promises.readFile(latestFile.path, 'utf8');
    const checkpoint = JSON.parse(rawData);
    
    // 恢复Set和Map结构
    return {
      ...checkpoint,
      completedPages: new Set(checkpoint.completedPages || []),
      partialPages: new Map(Object.entries(checkpoint.partialPages || {}))
    };
  }
  
  /**
   * 清理旧的检查点文件
   */
  async cleanupOldCheckpoints(keepCount = 5) {
    const checkpointTypes = ['page-checkpoint-', 'vote-progress-checkpoint-'];
    
    for (const prefix of checkpointTypes) {
      const files = fs.readdirSync(this.checkpointDir)
        .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(this.checkpointDir, file),
          mtime: fs.statSync(path.join(this.checkpointDir, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      // 保留最新的keepCount个文件，删除其余的
      const filesToDelete = files.slice(keepCount);
      
      for (const file of filesToDelete) {
        try {
          await fs.promises.unlink(file.path);
          console.log(`🗑️  已删除旧检查点: ${file.name}`);
        } catch (error) {
          console.error(`❌ 删除检查点失败: ${file.name}, 错误: ${error.message}`);
        }
      }
      
      if (filesToDelete.length > 0) {
        console.log(`✅ 清理完成: ${prefix}类型保留${keepCount}个，删除${filesToDelete.length}个`);
      }
    }
  }
  
  /**
   * 检查是否有可恢复的检查点
   */
  hasCheckpoints() {
    const files = fs.readdirSync(this.checkpointDir)
      .filter(file => 
        (file.startsWith('page-checkpoint-') || file.startsWith('vote-progress-checkpoint-')) 
        && file.endsWith('.json')
      );
    
    return files.length > 0;
  }
  
  /**
   * 获取检查点统计信息
   */
  getCheckpointStats() {
    const pageCheckpoints = fs.readdirSync(this.checkpointDir)
      .filter(file => file.startsWith('page-checkpoint-') && file.endsWith('.json'));
    
    const voteCheckpoints = fs.readdirSync(this.checkpointDir)
      .filter(file => file.startsWith('vote-progress-checkpoint-') && file.endsWith('.json'));
    
    return {
      pageCheckpoints: pageCheckpoints.length,
      voteCheckpoints: voteCheckpoints.length,
      total: pageCheckpoints.length + voteCheckpoints.length
    };
  }
}