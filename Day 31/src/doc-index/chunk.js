const LAW_HEADING_RE = /^(Глава\s+\d+\.\s+\S.*|Статья\s+\d+(?:\.\d+)?\.\s+\S.*)$/gmu;
const MD_HEADING_RE = /^(#{1,6})\s+(\S.*?)\s*$/gm;
const PAGE_HEADING_RE = /^page\s+(\d+)$/gm;
const CODE_FUNCTION_RE = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const CODE_CLASS_RE = /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)/gm;
const PART_RE = /^\d+(?:\.\d+)*\.\s+\S/;

export function chunkFixed(doc, { size = 1200, overlap = 200 } = {}) {
  const text = String(doc.text ?? "");
  const headings = findHeadings(text, doc);
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const floor = start + Math.floor(size * 0.6);
      const slice = text.slice(floor, end);
      let snap = -1;
      for (const mark of ["\n\n", ".\n", ". "]) {
        const index = slice.lastIndexOf(mark);
        if (index > snap) snap = index;
      }
      if (snap >= 0) end = floor + snap + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) {
      chunks.push({
        strategy: "fixed",
        text: piece,
        section: sectionAt(headings, start),
        boundary: pieceStartsAtHeading(piece, headings),
      });
    }
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return finalize(doc, chunks);
}

export function chunkStructural(doc, { maxChars = 2000, minChars = 200 } = {}) {
  const text = String(doc.text ?? "");
  const headings = findHeadings(text, doc);
  const fileSection = doc.kind === "code" ? doc.file || doc.title : doc.title;
  const raw = [];
  if (!headings.length) {
    raw.push(...piecesForSection(text, fileSection, true, maxChars));
  } else if (headings[0].offset > 0) {
    const preamble = text.slice(0, headings[0].offset).trim();
    if (preamble) {
      const section = doc.kind === "code" ? fileSection : "Преамбула";
      raw.push(...piecesForSection(preamble, section, true, maxChars));
    }
  }
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const next = headings[i + 1]?.offset ?? text.length;
    const body = text.slice(heading.offset, next).trim();
    if (!body) continue;
    raw.push(...piecesForSection(body, heading.title, true, maxChars, heading.raw ?? heading.title));
  }
  return finalize(doc, mergeShort(raw, minChars));
}

function findHeadings(text, doc) {
  const headings = [];
  if (doc?.kind === "code") {
    collect(text, headings, CODE_FUNCTION_RE, (match) => match[1]);
    collect(text, headings, CODE_CLASS_RE, (match) => match[1]);
  } else {
    collect(text, headings, LAW_HEADING_RE, (match) => match[1].trim());
    collect(text, headings, MD_HEADING_RE, (match) => match[2].trim());
    if (doc?.kind === "pdf") {
      collect(text, headings, PAGE_HEADING_RE, (match) => `page ${match[1]}`);
    }
  }
  headings.sort((left, right) => left.offset - right.offset);
  return headings;
}

function collect(text, headings, re, titleOf) {
  re.lastIndex = 0;
  for (const match of text.matchAll(re)) {
    const offset = match.index ?? 0;
    headings.push({
      offset,
      title: titleOf(match),
      raw: lineAt(text, offset),
    });
  }
}

function lineAt(text, offset) {
  const end = text.indexOf("\n", offset);
  return (end === -1 ? text.slice(offset) : text.slice(offset, end)).trim();
}

function sectionAt(headings, offset) {
  let section = "";
  for (const heading of headings) {
    if (heading.offset > offset) break;
    section = heading.title;
  }
  return section;
}

function pieceStartsAtHeading(piece, headings) {
  return headings.some((heading) => {
    const raw = heading.raw ?? heading.title;
    return piece.startsWith(raw) || piece.startsWith(heading.title);
  });
}

function opensSection(part, section, anchor) {
  return part.startsWith(section) || part.startsWith(anchor);
}

function piecesForSection(body, section, startsAtBoundary, maxChars, anchor = section) {
  if (body.length <= maxChars) {
    return [{ strategy: "structural", text: body, section, boundary: startsAtBoundary }];
  }
  const parts = splitParts(body);
  const pieces = [];
  for (const part of parts) {
    if (part.length <= maxChars) {
      pieces.push({
        strategy: "structural",
        text: part,
        section,
        boundary: startsAtBoundary && pieces.length === 0 && opensSection(part, section, anchor),
      });
      continue;
    }
    let offset = 0;
    while (offset < part.length) {
      const end = Math.min(part.length, offset + maxChars);
      const text = part.slice(offset, end).trim();
      if (text) {
        pieces.push({
          strategy: "structural",
          text,
          section,
          boundary: startsAtBoundary && pieces.length === 0 && opensSection(text, section, anchor),
        });
      }
      if (end >= part.length) break;
      offset = end;
    }
  }
  return pieces;
}

function splitParts(body) {
  const lines = body.split("\n");
  const parts = [];
  let current = [];
  for (const line of lines) {
    if (PART_RE.test(line.trim()) && current.some((item) => item.trim())) {
      parts.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  const tail = current.join("\n").trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

function mergeShort(chunks, minChars) {
  const merged = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.section === chunk.section && chunk.text.length < minChars) {
      prev.text = `${prev.text}\n${chunk.text}`;
      continue;
    }
    if (prev && prev.section === chunk.section && prev.text.length < minChars) {
      prev.text = `${prev.text}\n${chunk.text}`;
      continue;
    }
    merged.push({ ...chunk });
  }
  return merged;
}

function finalize(doc, chunks) {
  return chunks.map((chunk, index) => ({
    chunk_id: `${chunk.strategy}:${doc.file}:${index}`,
    source: doc.source,
    title: doc.title,
    file: doc.file,
    section: chunk.section || doc.title,
    strategy: chunk.strategy,
    text: chunk.text,
    boundary: Boolean(chunk.boundary),
  }));
}
