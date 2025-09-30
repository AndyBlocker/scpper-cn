import request from 'supertest';
import { createServer } from '../src/start';

jest.mock('pg', () => {
	function makeRows(sql: string) {
		if (sql.includes('COUNT(*)') && sql.includes('FROM "PageVersion"')) {
			return [{ _count: 42 }];
		}
		if (
			(sql.includes('FROM "UserStats"') && sql.includes('overallRank') && sql.includes('ORDER BY us."overallRank"')) ||
			(sql.includes('FROM "User" u') && sql.includes('JOIN "UserStats" us') && sql.includes('ORDER BY'))
		) {
			return [
				{ id: 1, displayName: 'Alice', rank: 1, overallRating: '123.45' },
				{ id: 2, displayName: 'Bob', rank: 2, overallRating: '100.00' }
			];
		}
		if (sql.includes('FROM "SiteStats"') && sql.includes('ORDER BY date DESC')) {
			return [{ date: '2025-08-23', totalUsers: 1000, activeUsers: 100, totalPages: 5000, totalVotes: 123456, newUsersToday: 5, newPagesToday: 10, newVotesToday: 200 }];
		}
		if (sql.includes('FROM "SeriesStats"')) {
			return [{ seriesNumber: 1, isOpen: true, totalSlots: 100, usedSlots: 80, usagePercentage: 80, milestonePageId: 123, lastUpdated: '2025-08-23T00:00:00Z' }];
		}
		if (sql.includes('FROM "PageStats"')) {
			return [{ uv: 200, dv: 50, wilson95: 0.9, controversy: 0.1, likeRatio: 0.8 }];
		}
		if (sql.includes('FROM "PageDailyStats"')) {
			return [
				{ date: '2025-08-20', votesUp: 10, votesDown: 2, totalVotes: 12, uniqueVoters: 11, revisions: 1 },
				{ date: '2025-08-21', votesUp: 15, votesDown: 4, totalVotes: 19, uniqueVoters: 18, revisions: 0 }
			];
		}
		if (sql.includes('FROM "UserDailyStats"')) {
			return [
				{ date: '2025-08-20', votesCast: 5, pagesCreated: 0, lastActivity: '2025-08-20T10:00:00Z' },
				{ date: '2025-08-21', votesCast: 7, pagesCreated: 1, lastActivity: '2025-08-21T09:00:00Z' }
			];
		}
		if (sql.includes('FROM "TrendingStats"')) {
			return [
				{ statType: 'top_pages', name: 'SCP-173', entityId: 173, entityType: 'page', score: '99.9', period: '30d', metadata: {}, calculatedAt: '2025-08-23T00:00:00Z' }
			];
		}
		if (sql.includes('FROM "LeaderboardCache"')) {
			return [{ payload: { items: [1, 2, 3] }, updatedAt: '2025-08-23T00:00:00Z', expiresAt: null }];
		}
		// default fallback
		return [{ ok: true }];
	}

	return {
		Pool: jest.fn().mockImplementation(() => ({
			query: jest.fn().mockImplementation((sql: string) => Promise.resolve({ rows: makeRows(sql) }))
		}))
	};
});

describe('Aggregate/Users/Stats routes', () => {
	test('GET /aggregate/pages returns count', async () => {
		const app = await createServer();
		const res = await request(app).get('/aggregate/pages').expect(200);
		expect(res.body._count).toBe(42);
	});

	test('GET /users/by-rank returns ranked users', async () => {
		const app = await createServer();
		const res = await request(app).get('/users/by-rank?limit=2').expect(200);
		expect(res.body[0].rank).toBe(1);
		expect(res.body[0].displayName).toBe('Alice');
	});

	test('GET /stats/site/latest returns latest site stats', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/site/latest').expect(200);
		expect(res.body.totalPages).toBe(5000);
	});

	test('GET /stats/series returns series stats', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/series').expect(200);
		expect(Array.isArray(res.body)).toBe(true);
		expect(res.body[0].seriesNumber).toBe(1);
	});

	test('GET /stats/pages/:wikidotId returns page stats', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/pages/123').expect(200);
		expect(res.body.uv).toBe(200);
	});

	test('GET /stats/pages/:wikidotId/daily returns daily page stats', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/pages/123/daily?limit=2').expect(200);
		expect(res.body.length).toBeGreaterThan(0);
		expect(res.body[0]).toHaveProperty('votesUp');
	});

	test('GET /stats/users/:id/daily returns daily user stats', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/users/1/daily?limit=2').expect(200);
		expect(res.body[0]).toHaveProperty('votesCast');
	});

	test('GET /stats/trending returns trending list', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/trending?statType=top_pages&period=30d').expect(200);
		expect(res.body[0]).toHaveProperty('statType');
	});

	test('GET /stats/leaderboard returns leaderboard payload', async () => {
		const app = await createServer();
		const res = await request(app).get('/stats/leaderboard?key=top-authors&period=30d').expect(200);
		expect(res.body).toHaveProperty('payload');
	});
});


