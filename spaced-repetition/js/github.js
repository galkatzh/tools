// Minimal GitHub Gists REST API client.

import { getToken, logout } from './auth.js';

const API = 'https://api.github.com';

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: `token ${getToken()}`,
      Accept: 'application/vnd.github+json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error('GitHub token expired or invalid (401). Please sign in again.');
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  return res;
}

/** List every gist that contains a file whose name starts with the prefix. */
export async function listDecks(prefix) {
  const decks = [];
  for (let page = 1; ; page++) {
    const gists = await (await api(`/gists?per_page=100&page=${page}`)).json();
    if (!gists.length) break;
    for (const g of gists) {
      if (Object.keys(g.files || {}).some((name) => name.startsWith(prefix))) {
        decks.push(g);
      }
    }
    if (gists.length < 100) break;
  }
  return decks;
}

/** Fetch a full gist, including file contents. */
export async function getGist(id) {
  return (await api(`/gists/${id}`)).json();
}

/** Resolve a gist file's content, fetching the raw URL when GitHub truncates it. */
export async function getFileContent(file) {
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    if (!res.ok) throw new Error(`Failed to fetch raw gist file: HTTP ${res.status}`);
    return res.text();
  }
  return file.content;
}

/** Replace one file's content within a gist. */
export async function updateGistFile(id, filename, content) {
  return (await api(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [filename]: { content } } }),
  })).json();
}
