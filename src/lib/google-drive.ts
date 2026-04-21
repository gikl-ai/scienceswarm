import { randomBytes } from "node:crypto";
import { google, type drive_v3 } from "googleapis";
import { getFrontendUrl } from "@/lib/config/ports";

// ── OAuth Configuration ─────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // Use URL joining instead of string concatenation so a trailing slash on
  // APP_ORIGIN (e.g. `http://localhost:3001/`) doesn't produce a broken
  // `//api/drive?action=callback` redirect URI.
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    new URL("/api/drive?action=callback", getFrontendUrl()).toString();

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// In-memory token store (per-session; swap for DB/Redis in production)
let storedTokens: Record<string, unknown> | null = null;
const pendingOAuthStates = new Map<string, number>();

function pruneExpiredOAuthStates(now = Date.now()): void {
  for (const [state, expiresAt] of pendingOAuthStates) {
    if (expiresAt <= now) {
      pendingOAuthStates.delete(state);
    }
  }
}

function createPendingOAuthState(): string {
  pruneExpiredOAuthStates();
  const state = randomBytes(24).toString("base64url");
  pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  return state;
}

function consumePendingOAuthState(state: string | null | undefined): boolean {
  if (!state) return false;

  pruneExpiredOAuthStates();
  const expiresAt = pendingOAuthStates.get(state);
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingOAuthStates.delete(state);
    return false;
  }

  pendingOAuthStates.delete(state);
  return true;
}

export class GoogleDriveOAuthStateError extends Error {
  constructor(message = "Invalid or expired OAuth state") {
    super(message);
    this.name = "GoogleDriveOAuthStateError";
  }
}

function getDriveClient(): drive_v3.Drive {
  if (!storedTokens) {
    throw new Error("Not authenticated with Google Drive. Please connect first.");
  }
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(storedTokens);
  return google.drive({ version: "v3", auth: oauth2 });
}

// ── Auth ─────────────────────────────────────────────────────────

export function getAuthUrl(): { state: string; url: string } {
  const oauth2 = getOAuth2Client();
  const state = createPendingOAuthState();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
  });
  return { state, url };
}

export async function handleCallback(
  code: string,
  state: string | null | undefined,
): Promise<{ success: boolean }> {
  if (!consumePendingOAuthState(state)) {
    throw new GoogleDriveOAuthStateError();
  }

  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  storedTokens = tokens as Record<string, unknown>;
  return { success: true };
}

export function isConnected(): boolean {
  return storedTokens !== null;
}

export function disconnect(): void {
  storedTokens = null;
}

// ── File Operations ──────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  iconLink?: string;
  webViewLink?: string;
}

export async function listFiles(folderId?: string): Promise<DriveFile[]> {
  const drive = getDriveClient();
  const query = folderId
    ? `'${folderId}' in parents and trashed = false`
    : `'root' in parents and trashed = false`;

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name, mimeType, size, modifiedTime, parents, iconLink, webViewLink)",
    orderBy: "folder, name",
    pageSize: 100,
  });

  return (res.data.files || []).map(fileToDto);
}

export async function listFolders(parentId?: string): Promise<DriveFile[]> {
  const drive = getDriveClient();
  const parent = parentId || "root";
  const query = `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name, mimeType, modifiedTime, parents, iconLink, webViewLink)",
    orderBy: "name",
    pageSize: 100,
  });

  return (res.data.files || []).map(fileToDto);
}

export async function searchFiles(query: string): Promise<DriveFile[]> {
  const drive = getDriveClient();
  const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;

  const res = await drive.files.list({
    q,
    fields: "files(id, name, mimeType, size, modifiedTime, parents, iconLink, webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: 50,
  });

  return (res.data.files || []).map(fileToDto);
}

export async function downloadFile(
  fileId: string
): Promise<{ name: string; content: string; mimeType: string }> {
  const drive = getDriveClient();

  // Get file metadata first
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size",
  });

  const name = meta.data.name || "untitled";
  const mimeType = meta.data.mimeType || "application/octet-stream";

  // Handle Google Workspace files via export
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export(
      { fileId, mimeType: "text/csv" },
      { responseType: "text" }
    );
    return { name: `${name}.csv`, content: res.data as string, mimeType: "text/csv" };
  }

  if (mimeType === "application/vnd.google-apps.document") {
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" }
    );
    return { name: `${name}.txt`, content: res.data as string, mimeType: "text/plain" };
  }

  if (mimeType === "application/vnd.google-apps.presentation") {
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" }
    );
    return { name: `${name}.txt`, content: res.data as string, mimeType: "text/plain" };
  }

  // Regular files: download content
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" }
  );

  return { name, content: res.data as string, mimeType };
}

// ── Helpers ──────────────────────────────────────────────────────

function fileToDto(file: drive_v3.Schema$File): DriveFile {
  return {
    id: file.id || "",
    name: file.name || "untitled",
    mimeType: file.mimeType || "application/octet-stream",
    size: file.size || undefined,
    modifiedTime: file.modifiedTime || undefined,
    parents: file.parents || undefined,
    iconLink: file.iconLink || undefined,
    webViewLink: file.webViewLink || undefined,
  };
}

export function isGoogleWorkspaceFile(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.");
}

export function getDriveFileIcon(mimeType: string): string {
  const icons: Record<string, string> = {
    "application/vnd.google-apps.folder": "📁",
    "application/vnd.google-apps.document": "📝",
    "application/vnd.google-apps.spreadsheet": "📊",
    "application/vnd.google-apps.presentation": "📽️",
    "application/vnd.google-apps.form": "📋",
    "application/pdf": "📄",
    "text/csv": "📊",
    "text/plain": "📃",
    "application/json": "📋",
    "image/png": "🖼️",
    "image/jpeg": "🖼️",
  };
  return icons[mimeType] || "📄";
}
