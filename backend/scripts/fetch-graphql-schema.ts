import { writeFile } from 'fs/promises';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default endpoint from our GraphQL client
const DEFAULT_ENDPOINT = 'https://apiv2.crom.avn.sh/graphql';

async function main() {
  const endpoint = process.env.GRAPHQL_ENDPOINT || DEFAULT_ENDPOINT;
  const outPath = process.env.SCHEMA_OUT || path.join(__dirname, '..', 'schema.graphql');

  const introspectionQuery = /* GraphQL */ `
    query IntrospectionQuery {
      __schema {
        queryType { name }
        mutationType { name }
        subscriptionType { name }
        types {
          ...FullType
        }
        directives {
          name
          description
          locations
          args {
            ...InputValue
          }
        }
      }
    }

    fragment FullType on __Type {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args {
          ...InputValue
        }
        type { ...TypeRef }
        isDeprecated
        deprecationReason
      }
      inputFields {
        ...InputValue
      }
      interfaces { ...TypeRef }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      possibleTypes { ...TypeRef }
    }

    fragment InputValue on __InputValue {
      name
      description
      type { ...TypeRef }
      defaultValue
    }

    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  `;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: introspectionQuery }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch schema: ${res.status} ${res.statusText} - ${text}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`);
  }

  // Convert introspection JSON to SDL using graphql utilities dynamically
  const { buildClientSchema, printSchema } = await import('graphql');
  const schema = buildClientSchema(data.data);
  const sdl = printSchema(schema);

  await writeFile(outPath, sdl, 'utf8');
  console.log(`Schema saved to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


