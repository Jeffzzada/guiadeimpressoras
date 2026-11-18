import { ApiError } from "./config.js";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const metadataCache = new Map();

export function clearSheetsMetadataCache() {
  metadataCache.clear();
}

export function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

export function buildA1Range(sheetTitle, a1 = "") {
  const quoted = quoteSheetTitle(sheetTitle);
  return a1 ? `${quoted}!${a1}` : quoted;
}

export function colToA1(zeroBasedCol) {
  let n = Math.floor(Number(zeroBasedCol));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Índice de coluna inválido: ${zeroBasedCol}`);
  }
  let col = "";
  while (n >= 0) {
    col = String.fromCharCode((n % 26) + 65) + col;
    n = Math.floor(n / 26) - 1;
  }
  return col;
}

export function createSheetsClient({ sheetId, getAccessToken, fetchImpl = fetch }) {
  const baseUrl = `${SHEETS_API_BASE}/${encodeURIComponent(sheetId)}`;

  async function request(path, init = {}) {
    const token = await getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMsg = String(data?.error?.message || `HTTP ${res.status}`);
      if (res.status === 403) {
        throw new ApiError(
          403,
          "Sem permissão na planilha do Google Sheets. Compartilhe a planilha como Editor com o e-mail da Service Account."
        );
      }
      if (res.status === 404) {
        throw new ApiError(
          404,
          "Planilha do Google Sheets não encontrada. Verifique a variável GOOGLE_SHEET_ID."
        );
      }
      if (res.status === 400 && /unable to parse range/i.test(apiMsg)) {
        const err = new ApiError(400, `Aba ou intervalo não encontrado na planilha: ${apiMsg}`);
        err.code = "MISSING_RANGE";
        throw err;
      }
      throw new ApiError(502, `Erro no Google Sheets: ${apiMsg}`);
    }

    return data;
  }

  async function getMetadata(forceRefresh = false) {
    if (!forceRefresh && metadataCache.has(sheetId)) {
      return metadataCache.get(sheetId);
    }

    const data = await request("?fields=properties.title,sheets.properties(sheetId,title)");
    const sheetIdsByTitle = new Map();
    for (const s of data?.sheets || []) {
      const title = s?.properties?.title;
      const numericId = s?.properties?.sheetId;
      if (title !== undefined && numericId !== undefined) {
        sheetIdsByTitle.set(title, numericId);
      }
    }

    const meta = {
      title: data?.properties?.title || "",
      sheetIdsByTitle
    };
    metadataCache.set(sheetId, meta);
    return meta;
  }

  async function getSheetId(sheetTitle) {
    let meta = await getMetadata(false);
    if (!meta.sheetIdsByTitle.has(sheetTitle)) {
      meta = await getMetadata(true);
    }
    const id = meta.sheetIdsByTitle.get(sheetTitle);
    if (id === undefined) {
      throw new ApiError(404, `Aba "${sheetTitle}" não encontrada na planilha.`);
    }
    return id;
  }

  async function batchGetValues(ranges) {
    if (!ranges.length) return [];
    const params = new URLSearchParams();
    for (const r of ranges) params.append("ranges", r);
    params.set("valueRenderOption", "UNFORMATTED_VALUE");
    params.set("dateTimeRenderOption", "FORMATTED_STRING");

    const data = await request(`/values:batchGet?${params.toString()}`);
    const valueRanges = Array.isArray(data?.valueRanges) ? data.valueRanges : [];
    return ranges.map((_, idx) => valueRanges[idx]?.values || []);
  }

  async function getValues(range) {
    const params = new URLSearchParams({
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING"
    });
    const data = await request(`/values/${encodeURIComponent(range)}?${params.toString()}`);
    return Array.isArray(data?.values) ? data.values : [];
  }

  async function appendRows(sheetTitle, rows) {
    if (!rows.length) return {};
    const range = encodeURIComponent(buildA1Range(sheetTitle, "A1"));
    return request(
      `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        body: JSON.stringify({
          majorDimension: "ROWS",
          values: rows
        })
      }
    );
  }

  async function batchUpdateValues(dataUpdates) {
    if (!dataUpdates.length) return {};
    return request("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: dataUpdates.map(u => ({
          range: u.range,
          majorDimension: "ROWS",
          values: u.values
        }))
      })
    });
  }

  async function addSheet(title) {
    const res = await request(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title } } }]
      })
    });
    const addedProps = res?.replies?.[0]?.addSheet?.properties;
    if (addedProps?.title !== undefined && addedProps?.sheetId !== undefined) {
      const meta = metadataCache.get(sheetId);
      if (meta) {
        meta.sheetIdsByTitle.set(addedProps.title, addedProps.sheetId);
      }
    } else {
      metadataCache.delete(sheetId);
    }
    return addedProps;
  }

  async function deleteRow(sheetTitle, zeroBasedRowIndex) {
    const numericSheetId = await getSheetId(sheetTitle);
    try {
      return await request(":batchUpdate", {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: numericSheetId,
                  dimension: "ROWS",
                  startIndex: zeroBasedRowIndex,
                  endIndex: zeroBasedRowIndex + 1
                }
              }
            }
          ]
        })
      });
    } catch (err) {
      metadataCache.delete(sheetId);
      throw err;
    }
  }

  return {
    getMetadata,
    getSheetId,
    batchGetValues,
    getValues,
    appendRows,
    batchUpdateValues,
    addSheet,
    deleteRow
  };
}
