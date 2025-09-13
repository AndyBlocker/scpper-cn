import { CoreQueries } from '../src/core/graphql/CoreQueries.js';
import { GraphQLClient } from '../src/core/client/GraphQLClient.js';

async function main() {
  const url = process.argv[2] || 'http://scp-wiki-cn.wikidot.com/scp-cn-3414-02';
  const cq = new CoreQueries();
  const { query, variables } = cq.buildQuery('singlePage', { url });
  const client = new GraphQLClient();
  const res = await client.request(query, variables);
  const page = res?.wikidotPage || null;
  console.log(JSON.stringify({ url, page }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


