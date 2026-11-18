/**
 * A thin client for the 12happy REST API (https://be.12hpy.com/docs/api).
 *
 * Auth is a scoped API key sent as a bearer token. Errors come back as RFC 7807
 * problem documents; ApiError keeps the parts a person needs to fix the call.
 */

export const DEFAULT_BASE_URL = 'https://be.12hpy.com/v1';
const USER_AGENT = '12happy-mcp/0.1.0';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly fieldErrors?: Record<string, string[]>,
    readonly retryAfter?: string | null,
  ) {
    super(detail);
  }

  /** What the model should be told: the API's own words, plus what to do about it. */
  explain(): string {
    const lines = [`12happy API error ${this.status}: ${this.detail}`];
    if (this.fieldErrors) {
      for (const [field, messages] of Object.entries(this.fieldErrors)) {
        lines.push(`- ${field}: ${messages.join(' ')}`);
      }
    }
    if (this.status === 401) {
      lines.push('The API key is missing, wrong or revoked. Create a new one on the API keys page of the 12happy console (app.12hpy.com).');
    } else if (this.status === 403) {
      lines.push('The API key lacks the scope for this action (for example monitors:write), or the plan does not include it.');
    } else if (this.status === 404) {
      lines.push('Not found, or it belongs to another account. List the monitors or incidents first to get a valid id.');
    } else if (this.status === 429) {
      lines.push(`Rate limited. Retry after ${this.retryAfter ?? 'a minute'} seconds.`);
    }
    return lines.join('\n');
  }
}

export interface Page<T> {
  data: T[];
  links?: { next?: string | null };
}

export class TwelveHappyClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: fall through with the raw text as the detail.
    }

    if (!res.ok) {
      const detail = json?.detail ?? json?.message ?? json?.title ?? (text.slice(0, 300) || res.statusText);
      throw new ApiError(res.status, detail, json?.errors, res.headers.get('Retry-After'));
    }
    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }

  /** Follow cursor pagination until `max` rows or the last page. */
  async all<T>(path: string, max = 500): Promise<T[]> {
    const rows: T[] = [];
    let next: string | null | undefined = path;
    while (next && rows.length < max) {
      const page: Page<T> = await this.get<Page<T>>(next);
      rows.push(...page.data);
      next = page.links?.next;
    }
    return rows.slice(0, max);
  }
}
