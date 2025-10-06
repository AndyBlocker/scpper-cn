export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const bffBase: string = (config.public as any).bffBase;

  const api = $fetch.create({
    baseURL: bffBase,
    headers: { accept: 'application/json' },
    credentials: 'include'
  });

  return {
    provide: {
      bff: api
    }
  };
});

