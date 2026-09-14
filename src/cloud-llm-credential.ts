export interface CloudLlmCredential {
  apiKey: string;
  endpointUrl: string;
}

const STORAGE_KEY = "zhiye.cloud.llm-credential.v1";
const SEMANTIC_STORAGE_KEY = "zhiye.cloud.semantic-credential.v1";
const SEMANTIC_ENDPOINT = "https://api.siliconflow.cn/v1/embeddings";
const encoder = new TextEncoder();

function credential(value: unknown): CloudLlmCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "apiKey" && key !== "endpointUrl")) return null;
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  if (!apiKey || encoder.encode(apiKey).byteLength > 16 * 1024 || /\p{Cc}/u.test(apiKey)) return null;
  try {
    const endpoint = new URL(typeof record.endpointUrl === "string" ? record.endpointUrl.trim() : "");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return null;
    return { apiKey, endpointUrl: endpoint.href };
  } catch {
    return null;
  }
}

export function loadCloudLlmCredential(storage: Storage): CloudLlmCredential | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const value = raw ? credential(JSON.parse(raw)) : null;
    if (raw && !value) storage.removeItem(STORAGE_KEY);
    return value;
  } catch {
    try { storage.removeItem(STORAGE_KEY); } catch { /* unavailable storage stays unused */ }
    return null;
  }
}

export function saveCloudLlmCredential(storage: Storage, apiKey: string, endpointUrl: string): CloudLlmCredential {
  const value = credential({ apiKey, endpointUrl });
  if (!value) throw new TypeError("Invalid cloud LLM credential");
  storage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
}

export function deleteCloudLlmCredential(storage: Storage) {
  storage.removeItem(STORAGE_KEY);
}

export function cloudLlmCredentialMatches(value: CloudLlmCredential | null, endpointUrl: string) {
  try {
    return value?.endpointUrl === new URL(endpointUrl.trim()).href;
  } catch {
    return false;
  }
}

export function cloudLlmCredentialHeaders(value: CloudLlmCredential | null, endpointUrl: string): Record<string, string> {
  return cloudLlmCredentialMatches(value, endpointUrl) ? { "X-Zhiye-LLM-Key": value!.apiKey } : {};
}

export function loadCloudSemanticCredential(storage: Storage): CloudLlmCredential | null {
  try {
    const raw = storage.getItem(SEMANTIC_STORAGE_KEY);
    const value = raw ? credential(JSON.parse(raw)) : null;
    if (raw && (!value || value.endpointUrl !== SEMANTIC_ENDPOINT)) storage.removeItem(SEMANTIC_STORAGE_KEY);
    return value?.endpointUrl === SEMANTIC_ENDPOINT ? value : null;
  } catch {
    try { storage.removeItem(SEMANTIC_STORAGE_KEY); } catch { /* unavailable storage stays unused */ }
    return null;
  }
}

export function saveCloudSemanticCredential(storage: Storage, apiKey: string) {
  const value = credential({ apiKey, endpointUrl: SEMANTIC_ENDPOINT });
  if (!value) throw new TypeError("Invalid embedding API key");
  storage.setItem(SEMANTIC_STORAGE_KEY, JSON.stringify(value));
  return value;
}

export function deleteCloudSemanticCredential(storage: Storage) {
  storage.removeItem(SEMANTIC_STORAGE_KEY);
}

export function cloudSemanticCredentialConfigured(value: CloudLlmCredential | null) {
  return value?.endpointUrl === SEMANTIC_ENDPOINT;
}

export function cloudSemanticCredentialHeaders(value: CloudLlmCredential | null): Record<string, string> {
  return cloudSemanticCredentialConfigured(value) ? { "X-Zhiye-Embedding-Key": value!.apiKey } : {};
}
