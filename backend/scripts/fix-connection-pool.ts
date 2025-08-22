import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function fixConnectionPool() {
  const prisma = getPrismaClient();
  
  try {
    console.log('=== Checking and Fixing Connection Pool ===\n');
    
    // Check current connections
    interface ConnectionStatus {
      connections: bigint;
      state: string | null;
      pid: number;
      query: string | null;
      query_start: Date | null;
      state_change: Date | null;
    }
    
    const activeConnections = await prisma.$queryRaw<ConnectionStatus[]>`
      SELECT 
        count(*) OVER() as connections,
        state,
        pid,
        query,
        query_start,
        state_change
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid != pg_backend_pid()
      ORDER BY query_start ASC
      LIMIT 100;
    `;
    
    console.log(`Total connections: ${activeConnections[0]?.connections || 0}`);
    
    // Group by state
    const stateGroups = activeConnections.reduce((acc, conn) => {
      const state = conn.state || 'unknown';
      if (!acc[state]) acc[state] = 0;
      acc[state]++;
      return acc;
    }, {} as Record<string, number>);
    
    console.log('\nConnections by state:');
    Object.entries(stateGroups).forEach(([state, count]) => {
      console.log(`  ${state}: ${count}`);
    });
    
    // Find long-running idle connections
    const now = new Date();
    const idleConnections = activeConnections.filter(conn => {
      if (conn.state === 'idle' && conn.state_change) {
        const idleTime = now.getTime() - new Date(conn.state_change).getTime();
        return idleTime > 60000; // idle for more than 1 minute
      }
      return false;
    });
    
    if (idleConnections.length > 0) {
      console.log(`\nFound ${idleConnections.length} long-running idle connections`);
      
      // Terminate long-running idle connections
      console.log('\nTerminating idle connections...');
      for (const conn of idleConnections) {
        try {
          await prisma.$queryRaw`
            SELECT pg_terminate_backend(${conn.pid})
          `;
          console.log(`  Terminated PID ${conn.pid}`);
        } catch (error) {
          console.error(`  Failed to terminate PID ${conn.pid}:`, error);
        }
      }
    }
    
    // Check connection limits
    const dbLimits = await prisma.$queryRaw<Array<{max_connections: string}>>`
      SHOW max_connections;
    `;
    
    console.log(`\nDatabase max_connections: ${dbLimits[0]?.max_connections}`);
    
    // Get current connection stats after cleanup
    const finalStats = await prisma.$queryRaw<Array<{connections: bigint}>>`
      SELECT count(*) as connections
      FROM pg_stat_activity
      WHERE datname = current_database()
    `;
    
    console.log(`Final active connections: ${finalStats[0]?.connections}`);
    
  } catch (error) {
    console.error('Error fixing connection pool:', error);
  } finally {
    await disconnectPrisma();
  }
}

fixConnectionPool();