import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function forceReleaseConnections() {
  const prisma = getPrismaClient();
  
  try {
    console.log('=== Force Releasing Idle Connections ===\n');
    
    // Get all connections except current one
    interface ConnectionInfo {
      pid: number;
      state: string | null;
      query: string | null;
      state_change: Date | null;
      application_name: string | null;
    }
    
    const connections = await prisma.$queryRaw<ConnectionInfo[]>`
      SELECT 
        pid,
        state,
        query,
        state_change,
        application_name
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid != pg_backend_pid()
        AND state = 'idle'
      ORDER BY state_change ASC;
    `;
    
    console.log(`Found ${connections.length} idle connections to terminate\n`);
    
    if (connections.length === 0) {
      console.log('No idle connections found.');
      return;
    }
    
    // Terminate all idle connections
    let terminated = 0;
    let failed = 0;
    
    for (const conn of connections) {
      try {
        const result = await prisma.$queryRaw<Array<{pg_terminate_backend: boolean}>>`
          SELECT pg_terminate_backend(${conn.pid}::int)
        `;
        
        if (result[0]?.pg_terminate_backend) {
          terminated++;
          console.log(`✅ Terminated PID ${conn.pid} (idle since: ${conn.state_change || 'unknown'})`);
        } else {
          failed++;
          console.log(`❌ Failed to terminate PID ${conn.pid}`);
        }
      } catch (error) {
        failed++;
        console.error(`❌ Error terminating PID ${conn.pid}:`, error);
      }
    }
    
    console.log(`\nSummary:`);
    console.log(`  Successfully terminated: ${terminated}`);
    console.log(`  Failed to terminate: ${failed}`);
    
    // Wait a moment for connections to close
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check final connection status
    const finalCheck = await prisma.$queryRaw<Array<{total: bigint, idle: bigint, active: bigint}>>`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE state = 'idle') as idle,
        COUNT(*) FILTER (WHERE state = 'active') as active
      FROM pg_stat_activity
      WHERE datname = current_database();
    `;
    
    console.log(`\nFinal connection status:`);
    console.log(`  Total connections: ${finalCheck[0]?.total || 0}`);
    console.log(`  Idle connections: ${finalCheck[0]?.idle || 0}`);
    console.log(`  Active connections: ${finalCheck[0]?.active || 0}`);
    
    // Show max connections for reference
    const maxConn = await prisma.$queryRaw<Array<{max_connections: string}>>`
      SHOW max_connections;
    `;
    
    console.log(`  Max connections allowed: ${maxConn[0]?.max_connections}`);
    console.log(`  Available slots: ${parseInt(maxConn[0]?.max_connections || '100') - Number(finalCheck[0]?.total || 0)}`);
    
  } catch (error) {
    console.error('Error releasing connections:', error);
  } finally {
    await disconnectPrisma();
  }
}

// Run the script
forceReleaseConnections();