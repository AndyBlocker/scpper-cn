import request from 'supertest';
import { createServer } from '../../src/start';

const hasDb = !!process.env.DATABASE_URL || !!process.env.PG_DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d('Live DB integration (requires DATABASE_URL)', () => {
	let app: any;

	beforeAll(async () => {
		jest.setTimeout(30000);
		app = await createServer();
	});

	test('GET /healthz ok', async () => {
		await request(app).get('/healthz').expect(200);
	});

	test('GET /pages list and use one wikidotId', async () => {
		const list = await request(app).get('/pages?limit=1').expect(200);
		expect(Array.isArray(list.body)).toBe(true);
		if (!list.body.length) return; // dataset may be empty
		const page = list.body[0];
		expect(page).toHaveProperty('wikidotId');

		// by-id
		await request(app)
			.get(`/pages/by-id?wikidotId=${encodeURIComponent(String(page.wikidotId))}`)
			.expect(200);

		// revisions (may be empty)
		await request(app)
			.get(`/pages/${encodeURIComponent(String(page.wikidotId))}/revisions?limit=5`)
			.expect(200);

		// votes fuzzy (may be empty)
		await request(app)
			.get(`/pages/${encodeURIComponent(String(page.wikidotId))}/votes/fuzzy?limit=5`)
			.expect(200);

		// cumulative ratings (may be empty)
		await request(app)
			.get(`/pages/${encodeURIComponent(String(page.wikidotId))}/ratings/cumulative`)
			.expect(200);

		// stats endpoints for page
		await request(app)
			.get(`/stats/pages/${encodeURIComponent(String(page.wikidotId))}`)
			.expect(200);
		await request(app)
			.get(`/stats/pages/${encodeURIComponent(String(page.wikidotId))}/daily?limit=5`)
			.expect(200);

		// matching
		if (page.url) {
			await request(app)
				.get(`/pages/matching?url=${encodeURIComponent(String(page.url))}&limit=5`)
				.expect(200);
		}
	});

	test('Aggregate and search endpoints', async () => {
		await request(app).get('/aggregate/pages').expect(200);
		await request(app)
			.get('/search/pages')
			.query({ query: 'scp', limit: '1' })
			.expect(200);
		await request(app)
			.get('/search/users')
			.query({ query: 'a', limit: '1' })
			.expect(200);
	});

	test('Users endpoints using /users/by-rank for discovery', async () => {
		const ranked = await request(app).get('/users/by-rank?limit=1').expect(200);
		if (!ranked.body.length) return; // dataset may be empty
		const user = ranked.body[0];
		expect(user).toHaveProperty('id');
		const id = String(user.id);

		await request(app).get(`/users/${encodeURIComponent(id)}`).expect(200);
		await request(app).get(`/users/${encodeURIComponent(id)}/stats`).expect(200);
		await request(app)
			.get(`/users/${encodeURIComponent(id)}/pages?limit=5`)
			.expect(200);
		await request(app)
			.get(`/stats/users/${encodeURIComponent(id)}/daily?limit=5`)
			.expect(200);
	});

	test('Site/series/trending/leaderboard stats', async () => {
		// site latest may exist
		await request(app).get('/stats/site/latest').expect(200);
		// series may exist
		await request(app).get('/stats/series').expect(200);
		// trending may exist even if empty
		await request(app)
			.get('/stats/trending')
			.expect(200);
		// leaderboard is cached data and may not exist -> allow 200/404
		const res = await request(app)
			.get('/stats/leaderboard?key=top-authors&period=30d');
		expect([200, 404]).toContain(res.status);
	});
});


