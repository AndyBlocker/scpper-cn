import { request } from "undici";

export async function httpHEAD(url: string, timeoutMs: number, headers?: Record<string,string>) {
  const { statusCode, headers: respHeaders } = await request(url, {
    method: "HEAD",
    headers,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs
  });
  return { status: statusCode, headers: respHeaders };
}

export async function httpGET(url: string, timeoutMs: number, headers?: Record<string,string>) {
  const res = await request(url, {
    method: "GET",
    headers,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs
  });
  return res;
}


