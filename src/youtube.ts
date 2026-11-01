// YouTube Data API v3 — 브라우저에서 직접 호출 (Google Identity Services 토큰, 서버 없음)

const SCOPE = "https://www.googleapis.com/auth/youtube";
const API = "https://www.googleapis.com/youtube/v3";

// 단위: https://developers.google.com/youtube/v3/determine_quota_cost
export const COST = { list: 1, videoInsert: 1600, playlistItemInsert: 50, playlistInsert: 50 };

export class QuotaError extends Error {}

// quotaExceeded = API 일일 quota, uploadLimitExceeded = 채널 업로드 개수 한도 (status 400/403 모두 가능)
const LIMIT_RE = /quotaExceeded|uploadLimitExceeded|dailyLimitExceeded/;
const limitMessage = (body: string) =>
  /uploadLimitExceeded/.test(body) ? "YouTube 채널 업로드 개수 한도 초과 (uploadLimitExceeded)" : "YouTube API 일일 quota 초과";

let token: { value: string; exp: number } | null = null;
let client: any = null;

function loadGis() {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();
  return new Promise<void>((ok, err) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => ok();
    s.onerror = () => err(new Error("Google 로그인 스크립트 로드 실패"));
    document.head.appendChild(s);
  });
}

export const signedIn = () => !!token && token.exp > Date.now() + 60_000;
export const tokenMinutesLeft = () => (token ? (token.exp - Date.now()) / 60000 : 0);

export async function signIn(clientId: string, prompt: "" | "consent" = "") {
  if (!clientId) throw new Error("설정에서 Google OAuth 클라이언트 ID 를 입력하세요");
  await loadGis();
  return new Promise<void>((ok, err) => {
    client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r: any) => {
        if (r.error) return err(new Error(r.error_description || r.error));
        token = { value: r.access_token, exp: Date.now() + Number(r.expires_in) * 1000 };
        ok();
      },
      error_callback: (e: any) => err(new Error(e.message || e.type)),
    });
    client.requestAccessToken({ prompt });
  });
}

export const signOut = () => {
  if (token) (window as any).google?.accounts?.oauth2?.revoke(token.value, () => {});
  token = null;
};

async function check(res: Response) {
  if (res.ok) return res;
  const body = await res.text();
  if (LIMIT_RE.test(body)) throw new QuotaError(limitMessage(body));
  if (res.status === 401) token = null;
  throw new Error(`YouTube API ${res.status}: ${body.slice(0, 300)}`);
}

async function api(path: string, params: Record<string, string>, init: RequestInit = {}) {
  if (!token) throw new Error("Google 로그인이 필요합니다");
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, {
    ...init,
    headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json", ...init.headers },
  });
  return (await check(res)).json();
}

export async function channelTitle() {
  const r = await api("channels", { part: "snippet", mine: "true" });
  return r.items?.[0]?.snippet?.title as string | undefined;
}

// 제목 또는 ID 로 재생목록 찾기, 없으면 생성. 반환: [id, 소비한 quota]
export async function ensurePlaylist(name: string, privacy: string): Promise<[string, number]> {
  let cost = 0;
  let pageToken = "";
  do {
    const r = await api("playlists", { part: "snippet", mine: "true", maxResults: "50", ...(pageToken && { pageToken }) });
    cost += COST.list;
    const hit = r.items.find((p: any) => p.id === name || p.snippet.title === name);
    if (hit) return [hit.id, cost];
    pageToken = r.nextPageToken ?? "";
  } while (pageToken);
  const p = await api("playlists", { part: "snippet,status" }, {
    method: "POST",
    body: JSON.stringify({ snippet: { title: name }, status: { privacyStatus: privacy } }),
  });
  return [p.id, cost + COST.playlistInsert];
}

export async function addToPlaylist(playlistId: string, videoId: string) {
  await api("playlistItems", { part: "snippet" }, {
    method: "POST",
    body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
  });
}

// 채널 업로드 목록의 설명란 "Source: a.MP4, b.MP4" 로 업로드 여부 확인 → { 원본파일명: videoId }
export async function listUploadedSources(): Promise<[Record<string, string>, number]> {
  const ch = await api("channels", { part: "contentDetails", mine: "true" });
  let cost = COST.list;
  const uploads = ch.items[0].contentDetails.relatedPlaylists.uploads;
  const map: Record<string, string> = {};
  let pageToken = "";
  do {
    const r = await api("playlistItems", { part: "snippet", playlistId: uploads, maxResults: "50", ...(pageToken && { pageToken }) });
    cost += COST.list;
    for (const it of r.items) {
      const desc: string = it.snippet.description ?? "";
      const m = /Source:\s*(.+)/.exec(desc);
      const prefix = /^Overlay:\s*HUD/m.test(desc) ? "hud:" : "";
      if (m) for (const f of m[1].split(/,\s*/)) map[prefix + f.trim()] = it.snippet.resourceId.videoId;
    }
    pageToken = r.nextPageToken ?? "";
  } while (pageToken);
  return [map, cost];
}

export interface UploadMeta {
  title: string;
  description: string;
  privacy: string;
  recordingDate?: string;
}

function xhrPut(url: string, body: Blob, headers: Record<string, string>, onProgress: (n: number) => void, signal?: AbortSignal) {
  return new Promise<XMLHttpRequest>((ok, err) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => ok(x);
    x.onerror = () => err(new Error("network"));
    x.onabort = () => err(new DOMException("중단됨", "AbortError"));
    signal?.addEventListener("abort", () => x.abort());
    x.send(body);
  });
}

// resumable 업로드. 네트워크 오류 시 서버가 받은 위치부터 재시도
export async function uploadVideo(file: File, meta: UploadMeta, onProgress: (sent: number, total: number) => void, signal?: AbortSignal) {
  if (!token) throw new Error("Google 로그인이 필요합니다");
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,recordingDetails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.value}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(file.size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title: meta.title.slice(0, 100), description: meta.description, categoryId: "22" },
        status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
        ...(meta.recordingDate && { recordingDetails: { recordingDate: meta.recordingDate } }),
      }),
      signal,
    },
  );
  await check(init);
  const url = init.headers.get("Location");
  if (!url) throw new Error("업로드 URL 을 받지 못함 (Location 헤더)");

  let offset = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const x = await xhrPut(
        url,
        file.slice(offset),
        { "Content-Type": "video/mp4", ...(offset > 0 && { "Content-Range": `bytes ${offset}-${file.size - 1}/${file.size}` }) },
        (n) => onProgress(offset + n, file.size),
        signal,
      );
      if (x.status === 200 || x.status === 201) return JSON.parse(x.responseText).id as string;
      if (LIMIT_RE.test(x.responseText)) throw new QuotaError(limitMessage(x.responseText));
      if (x.status < 500 && x.status !== 308) throw new Error(`업로드 실패 ${x.status}: ${x.responseText.slice(0, 300)}`);
    } catch (e) {
      if (e instanceof QuotaError || (e as Error).name === "AbortError" || /업로드 실패/.test(String(e))) throw e;
    }
    if (attempt >= 8) throw new Error("업로드 재시도 횟수 초과");
    await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
    // 서버가 받은 바이트 확인
    const st = await xhrPut(url, new Blob(), { "Content-Range": `bytes */${file.size}` }, () => {}, signal).catch(() => null);
    if (st?.status === 200 || st?.status === 201) return JSON.parse(st.responseText).id as string;
    const range = st?.getResponseHeader("Range");
    offset = range ? Number(range.split("-")[1]) + 1 : st?.status === 308 ? 0 : offset;
  }
}
