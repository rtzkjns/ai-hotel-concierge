// Low-level Exely Connect API client (Search + Content + Reservation).
// Port of kazzhol-portal src/Integrations/Exely/Client.php.

/** Exely SLA: answer within 10s or treat the call as failed. */
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_MAX_CHARS = 300;

export interface ExelyHttpConfig {
  baseUrl: string;
}

export interface TokenSource {
  getToken(): Promise<string>;
}

export class ExelyHttp {
  private readonly base: string;

  constructor(
    cfg: ExelyHttpConfig,
    private readonly tokens: TokenSource,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.tokens.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchFn(this.base + path, init);
    const raw = await res.text();
    if (!res.ok) {
      // NEVER include the bearer token here; only method/path/status/body excerpt.
      throw new Error(
        `Exely ${method} ${path} → HTTP ${res.status}: ${raw.slice(0, ERROR_BODY_MAX_CHARS)}`,
      );
    }
    return raw ? (JSON.parse(raw) as unknown) : {};
  }

  /**
   * Наличие и цены по ОДНОМУ отелю — все свободные категории.
   *
   * Раньше здесь звался POST /room-stays/search. Это агрегирующий поиск «по многим
   * отелям», и он по устройству отдаёт ОДНО лучшее предложение на отель: гость видел
   * «Standard Twin», когда свободны были ещё Standard Double и Deluxe Apartments.
   * Ни один параметр этого не менял — фильтр по категориям там просто игнорируется
   * (проверено запросом с несуществующим id: ответ тот же).
   * Детальный эндпоинт по конкретному отелю возвращает каждую доступную комбинацию
   * «номер + тариф», что отелю и нужно.
   */
  search(
    propertyId: string,
    arrival: string,
    departure: string,
    adults: number,
    childAges: number[] = [],
  ): Promise<unknown> {
    const qs = new URLSearchParams({
      arrivalDate: arrival,
      departureDate: departure,
      adults: String(adults),
      include: 'roomTypeShortContent|ratePlanShortContent',
    });
    for (const age of childAges) qs.append('childAges', String(age));
    return this.request(
      'GET',
      `/api/search/v1/properties/${encodeURIComponent(propertyId)}/room-stays?${qs.toString()}`,
    );
  }

  /** Прежний агрегирующий поиск — оставлен на случай запроса сразу по нескольким отелям. */
  searchAcrossProperties(
    propertyIds: string[],
    arrival: string,
    departure: string,
    adults: number,
    childAges: number[] = [],
  ): Promise<unknown> {
    return this.request('POST', '/api/search/v1/properties/room-stays/search', {
      propertyIds,
      adults,
      childAges,
      arrivalDate: arrival,
      departureDate: departure,
      // WITHOUT this the response carries only ids — roomType={id, placements}, ratePlan={id} —
      // and the bot fell back to `fullPlacementsName`, telling the guest the room is called
      // «2 взрослых на основных местах». The flag is in Exely's own OpenAPI schema and fills a
      // `content` block with the real category and rate names.
      include: 'roomTypeShortContent|ratePlanShortContent',
    });
  }

  /** Property catalog: room types, rate plans, services, photos. */
  content(propertyId: string): Promise<unknown> {
    return this.request('GET', `/api/content/v1/properties/${encodeURIComponent(propertyId)}`);
  }

  /** POST to the Reservation API ({base}/api/reservation{path}). */
  resPost(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', `/api/reservation${path}`, body);
  }

  /** GET from the Reservation API. */
  resGet(path: string): Promise<unknown> {
    return this.request('GET', `/api/reservation${path}`);
  }
}
