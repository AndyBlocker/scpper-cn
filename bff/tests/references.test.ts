import request from 'supertest';
import { createServer } from '../src/start';

const queryMock = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock
  }))
}));

describe('References routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('GET /references/graph returns latest snapshot', async () => {
    const snapshot = {
      label: 'latest',
      description: 'sample',
      generatedAt: '2024-11-20T12:00:00.000Z',
      stats: {
        generatedAt: '2024-11-20T12:00:00.000Z',
        topInbound: [
          { rank: 1, wikidotId: 1001, pageId: 1, title: 'Page A', url: 'http://example.com/a', inbound: 12, outbound: 3 }
        ],
        topOutbound: [
          { rank: 1, wikidotId: 1002, pageId: 2, title: 'Page B', url: 'http://example.com/b', inbound: 5, outbound: 20 }
        ],
        graph: {
          nodeCount: 2,
          edgeCount: 1,
          maxWeight: 8,
          nodes: [
            { wikidotId: 1001, pageId: 1, title: 'Page A', url: 'http://example.com/a', inbound: 12, outbound: 3 },
            { wikidotId: 1002, pageId: 2, title: 'Page B', url: 'http://example.com/b', inbound: 5, outbound: 20 }
          ],
          edges: [
            { source: 1002, target: 1001, weight: 8 }
          ]
        }
      }
    };

    queryMock.mockResolvedValueOnce({ rows: [snapshot] });

    const app = await createServer();
    const res = await request(app).get('/references/graph').expect(200);

    expect(res.body.label).toBe('latest');
    expect(res.body.data.graph.nodeCount).toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('GET /references/graph returns 404 when snapshot missing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const app = await createServer();
    await request(app).get('/references/graph').expect(404);
  });
});

