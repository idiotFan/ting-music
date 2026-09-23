import { icon } from "./dom";
import {
  esc,
  playlistLabel,
  type Playlist,
  type Song,
  type Source,
} from "./library";
import {
  albumsOf,
  highlightRuns,
  normalizeName,
  releaseDate,
  songArtists,
} from "./catalog-model.mjs";
import { formatTime } from "./model.mjs";

/**
 * Artist and album pages, and the non-song search tabs. Both platforms answer
 * in one shape (see src-tauri/src/catalog.rs and qq/client.rs); files on this
 * machine get the same pages built from the local shelf.
 */
export type CatalogSource = Source | "local";
export type ArtistRef = {
  source: CatalogSource;
  id: number;
  mid?: string;
  name: string;
};
export type Artist = ArtistRef & {
  avatar: string;
  albumCount: number;
  songCount: number;
  alias: string;
};
export type AlbumRef = {
  source: CatalogSource;
  id: number;
  mid?: string;
  name: string;
  artist?: string;
};
export type Album = AlbumRef & {
  artist: string;
  artistId: number;
  artistMid?: string;
  cover: string;
  publishTime: number;
  trackCount: number;
};
export type ArtistPage = {
  artist: Artist;
  brief: string;
  songs: Song[];
  similar: Artist[];
};
export type AlbumPage = { album: Album; description: string; songs: Song[] };
export type AlbumList = { albums: Album[]; total: number; more: boolean };
export type CatalogKind = "artist" | "album" | "playlist";
export type CatalogPage = {
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  total: number;
};
type Cloud = <T>(
  command: string,
  args?: Record<string, unknown>,
  source?: Source,
) => Promise<T>;

const isLocal = (s: Song) => !!(s.localUrl || s.localPath);

export function artistRefs(song: Song): ArtistRef[] {
  const source: CatalogSource = isLocal(song)
    ? "local"
    : song.source || "netease";
  return songArtists(song).map((a) => ({ source, ...a }));
}
export function albumRef(song: Song): AlbumRef | undefined {
  if (!song.album) return undefined;
  return {
    source: isLocal(song) ? "local" : song.source || "netease",
    id: song.albumId || 0,
    mid: song.albumMid,
    name: song.album,
    artist: song.artist,
  };
}
const known = (ref: ArtistRef | AlbumRef) =>
  ref.source === "qq" ? !!ref.mid : ref.id > 0;

export async function search(
  cloud: Cloud,
  source: Source,
  query: string,
  kind: CatalogKind,
  offset: number,
): Promise<CatalogPage> {
  const page = await cloud<CatalogPage>(
    "catalog_search",
    { query, kind, offset },
    source,
  );
  return {
    ...page,
    playlists: page.playlists.map((p) => ({ ...p, source })),
  };
}

/** Old saved songs carry names only; find the page by name on the same platform. */
async function resolveArtist(cloud: Cloud, ref: ArtistRef): Promise<ArtistRef> {
  if (known(ref) || ref.source === "local") return ref;
  const page = await search(cloud, ref.source, ref.name, "artist", 0);
  const want = normalizeName(ref.name);
  const found =
    page.artists.find((a) => normalizeName(a.name) === want) ||
    page.artists.find((a) => normalizeName(a.alias) === want);
  if (!found)
    throw new Error(
      `没有在${ref.source === "qq" ? "QQ音乐" : "网易云"}找到歌手「${ref.name}」`,
    );
  return found;
}
async function resolveAlbum(cloud: Cloud, ref: AlbumRef): Promise<AlbumRef> {
  if (known(ref) || ref.source === "local") return ref;
  const page = await search(
    cloud,
    ref.source,
    `${ref.name} ${ref.artist || ""}`.trim(),
    "album",
    0,
  );
  const want = normalizeName(ref.name);
  const found = page.albums.find((a) => normalizeName(a.name) === want);
  if (!found) throw new Error(`没有找到专辑「${ref.name}」`);
  return found;
}

export async function loadArtist(
  cloud: Cloud,
  ref: ArtistRef,
  locals: Song[],
): Promise<ArtistPage> {
  if (ref.source === "local") return localArtist(ref.name, locals);
  const target = await resolveArtist(cloud, ref);
  const page = await cloud<ArtistPage>(
    "artist_detail",
    { id: target.id, mid: target.mid },
    ref.source,
  );
  const source = ref.source;
  const tag = (s: Song): Song => ({ ...s, source });
  return {
    ...page,
    artist: { ...page.artist, source },
    songs: page.songs.map(tag),
    similar: (page.similar || []).map((a) => ({ ...a, source })),
  };
}
export async function loadArtistAlbums(
  cloud: Cloud,
  artist: Artist,
  offset: number,
  locals: Song[],
): Promise<AlbumList> {
  if (artist.source === "local") {
    const albums = localAlbums(artist.name, locals);
    return { albums, total: albums.length, more: false };
  }
  const list = await cloud<AlbumList>(
    "artist_albums",
    { id: artist.id, mid: artist.mid, offset },
    artist.source,
  );
  return {
    ...list,
    albums: list.albums.map((a) => ({ ...a, source: artist.source })),
  };
}
export async function loadAlbum(
  cloud: Cloud,
  ref: AlbumRef,
  locals: Song[],
): Promise<AlbumPage> {
  if (ref.source === "local") return localAlbum(ref, locals);
  const target = await resolveAlbum(cloud, ref);
  const page = await cloud<AlbumPage>(
    "album_detail",
    { id: target.id, mid: target.mid },
    ref.source,
  );
  const source = ref.source;
  return {
    ...page,
    album: { ...page.album, source },
    songs: page.songs.map((s) => ({ ...s, source })),
  };
}

// Local shelf ---------------------------------------------------------------
const credits = (song: Song, name: string) =>
  songArtists(song).some((a) => normalizeName(a.name) === normalizeName(name));
function localArtist(name: string, locals: Song[]): ArtistPage {
  const songs = locals.filter((s) => credits(s, name));
  return {
    artist: {
      source: "local",
      id: 0,
      name,
      avatar: songs.find((s) => s.cover)?.cover || "",
      albumCount: albumsOf(songs).length,
      songCount: songs.length,
      alias: "",
    },
    brief: "",
    songs,
    similar: [],
  };
}
function localAlbums(artist: string, locals: Song[]): Album[] {
  return albumsOf(locals.filter((s) => credits(s, artist))).map((g, i) => ({
    source: "local" as const,
    id: -(i + 1),
    name: g.name,
    artist,
    artistId: 0,
    cover: g.cover,
    publishTime: 0,
    trackCount: g.songs.length,
  }));
}
function localAlbum(ref: AlbumRef, locals: Song[]): AlbumPage {
  const songs = locals.filter(
    (s) => normalizeName(s.album) === normalizeName(ref.name),
  );
  const artists = [...new Set(songs.map((s) => s.artist))];
  return {
    album: {
      source: "local",
      id: 0,
      name: ref.name,
      artist: artists.join(" / ") || ref.artist || "",
      artistId: 0,
      cover: songs.find((s) => s.cover)?.cover || "",
      publishTime: 0,
      trackCount: songs.length,
    },
    description: "",
    songs,
  };
}

// Markup --------------------------------------------------------------------
/** Escaped text with every search term wrapped in <mark>. */
export function hl(text: string, query = ""): string {
  if (!query) return esc(text);
  return highlightRuns(text, query)
    .map((r: { text: string; match: boolean }) =>
      r.match ? `<mark>${esc(r.text)}</mark>` : esc(r.text),
    )
    .join("");
}
/** Each credited artist as its own link; the row decides what a click means. */
export function artistLinks(song: Song, query = ""): string {
  const refs = songArtists(song);
  if (!refs.length) return "";
  return refs
    .map(
      (a: { name: string }, i: number) =>
        `<button type="button" class="meta-link" data-artist-link="${i}" title="查看歌手 ${esc(a.name)}">${hl(a.name, query)}</button>`,
    )
    .join('<span class="meta-sep"> / </span>');
}
export function albumLink(song: Song, query = ""): string {
  if (!song.album) return "";
  return `<button type="button" class="meta-link" data-album-link title="查看专辑 ${esc(song.album)}">${hl(song.album, query)}</button>`;
}
export const qualityBadge = (song: Song) =>
  song.quality === "hires"
    ? '<span class="quality-badge">Hi-Res</span>'
    : song.quality === "lossless"
      ? '<span class="quality-badge">无损</span>'
      : "";

const sourceLabel = (source: CatalogSource) =>
  source === "local" ? "本地" : source === "qq" ? "QQ音乐" : "网易云";
const art = (src: string, alt: string, round = false) =>
  src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer"/>`
    : `<span class="fallback-cover">${icon(round ? "UserRound" : "Disc3")}</span>`;

export type Card =
  | { kind: "artist"; value: Artist }
  | { kind: "album"; value: Album }
  | { kind: "playlist"; value: Playlist };
export function cardMarkup(card: Card, index: number, query = ""): string {
  if (card.kind === "artist") {
    const a = card.value;
    const meta = [
      a.alias,
      a.songCount ? `单曲 ${a.songCount}` : "",
      a.albumCount ? `专辑 ${a.albumCount}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `<button class="catalog-card artist-card" data-card="${index}"><span class="catalog-art round">${art(a.avatar, a.name, true)}</span><strong>${hl(a.name, query)}</strong><span class="catalog-meta">${esc(meta || sourceLabel(a.source))}</span></button>`;
  }
  if (card.kind === "album") {
    const a = card.value;
    const meta = [
      releaseDate(a.publishTime).slice(0, 4),
      a.trackCount ? `${a.trackCount} 首` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `<button class="catalog-card album-card" data-card="${index}"><span class="catalog-art">${art(a.cover, a.name)}</span><strong>${hl(a.name, query)}</strong><span class="catalog-meta">${hl(a.artist, query)}${meta ? " · " + esc(meta) : ""}</span></button>`;
  }
  const p = card.value;
  return `<button class="catalog-card playlist-result" data-card="${index}"><span class="catalog-art">${art(p.cover, p.name)}</span><strong>${hl(p.name, query)}</strong><span class="catalog-meta">${esc(`${p.trackCount} 首 · ${p.creator || playlistLabel(p)}`)}</span></button>`;
}

/** Top-of-results card when the query names an artist or an album outright. */
export function bestMatchMarkup(card: Card): string {
  const isArtist = card.kind === "artist";
  const a = card.value as Artist & Album;
  const title = a.name;
  const cover = isArtist ? a.avatar : a.cover;
  const meta = isArtist
    ? [
        a.alias,
        a.songCount ? `单曲 ${a.songCount}` : "",
        a.albumCount ? `专辑 ${a.albumCount}` : "",
      ]
    : [
        a.artist,
        releaseDate(a.publishTime).slice(0, 4),
        a.trackCount ? `${a.trackCount} 首` : "",
      ];
  return `<button id="best-match" class="best-match" data-best-match><span class="catalog-art${isArtist ? " round" : ""}">${art(cover, title, isArtist)}</span><span class="best-text"><small>最佳匹配 · ${isArtist ? "歌手" : "专辑"} · ${sourceLabel(a.source)}</small><strong>${esc(title)}</strong><span>${esc(meta.filter(Boolean).join(" · "))}</span></span>${icon("ChevronRight")}</button>`;
}

export function artistHeader(page: ArtistPage): string {
  const a = page.artist;
  const stats = [
    sourceLabel(a.source),
    a.songCount ? `单曲 ${a.songCount}` : "",
    a.albumCount ? `专辑 ${a.albumCount}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="detail-hero artist-hero"><span class="detail-art round">${art(a.avatar, a.name, true)}</span><div class="detail-text"><small>歌手</small><h3>${esc(a.name)}</h3>${a.alias ? `<p class="detail-alias">${esc(a.alias)}</p>` : ""}<p class="detail-meta">${esc(stats)}</p>${page.brief ? `<p class="detail-brief" data-clamped="true">${esc(page.brief)}</p><button type="button" class="quiet detail-more" data-toggle-brief>展开</button>` : ""}</div></div>`;
}
export function albumHeader(page: AlbumPage): string {
  const a = page.album;
  const minutes = Math.round(
    page.songs.reduce((sum, s) => sum + (s.duration || 0), 0) / 60000,
  );
  const stats = [
    sourceLabel(a.source),
    releaseDate(a.publishTime),
    `${a.trackCount || page.songs.length} 首`,
    minutes ? `${minutes} 分钟` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const artists = a.artist
    .split(/\s*\/\s*/)
    .filter(Boolean)
    .map(
      (name, i) =>
        `<button type="button" class="meta-link" data-album-artist="${i}">${esc(name)}</button>`,
    )
    .join('<span class="meta-sep"> / </span>');
  return `<div class="detail-hero album-hero"><span class="detail-art">${art(a.cover, a.name)}</span><div class="detail-text"><small>专辑</small><h3>${esc(a.name)}</h3><p class="detail-artists">${artists}</p><p class="detail-meta">${esc(stats)}</p>${page.description ? `<p class="detail-brief" data-clamped="true">${esc(page.description)}</p><button type="button" class="quiet detail-more" data-toggle-brief>展开</button>` : ""}</div></div>`;
}
export const durationLabel = (ms: number) => (ms ? formatTime(ms / 1000) : "—");
