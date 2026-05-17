// BM25 lexical ranking, hand-rolled and dependency-free.
//
// BM25 scores a document for a query by summing, over each query term, an IDF
// weight times a saturating term-frequency factor. It is the lexical half of
// hybrid search: it rewards exact word overlap, which embeddings tend to blur.
//
// The vault is a curated knowledge base (tens to low-hundreds of documents),
// so the whole corpus is ranked in memory on every query. No inverted index.

// Okapi BM25 free parameters. k1 controls term-frequency saturation; b controls
// how strongly document length normalises the score. These are the standard
// defaults and need no tuning at this corpus size.
const K1 = 1.5;
const B = 0.75;

// Common English words carry no discriminating signal; dropping them keeps IDF
// meaningful and snippets pointed at content words.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "he", "her", "his", "in", "is", "it", "its", "of", "on",
  "or", "she", "that", "the", "their", "them", "they", "this", "to", "was",
  "were", "will", "with", "you", "your",
]);

// Lowercases, splits on any non-alphanumeric run, and drops stopwords and
// 1-character fragments. Used identically for documents and queries so the
// term spaces line up.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface Bm25Document {
  path: string;
  tokens: string[];
}

export interface Bm25Model {
  // path -> (term -> count in that document)
  termFreqs: Map<string, Map<string, number>>;
  // term -> number of documents containing it
  docFreqs: Map<string, number>;
  // path -> token count of that document
  docLengths: Map<string, number>;
  docCount: number;
  avgDocLength: number;
}

export function buildBm25(docs: Bm25Document[]): Bm25Model {
  const termFreqs = new Map<string, Map<string, number>>();
  const docFreqs = new Map<string, number>();
  const docLengths = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tf = new Map<string, number>();
    for (const term of doc.tokens) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    termFreqs.set(doc.path, tf);
    docLengths.set(doc.path, doc.tokens.length);
    totalLength += doc.tokens.length;
    for (const term of tf.keys()) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  return {
    termFreqs,
    docFreqs,
    docLengths,
    docCount: docs.length,
    avgDocLength: docs.length > 0 ? totalLength / docs.length : 0,
  };
}

export interface Bm25Hit {
  path: string;
  score: number;
}

// Scores every document against the query terms and returns the matches
// (score > 0) sorted high to low. A document with zero query-term overlap is
// omitted entirely rather than returned with a zero score.
export function searchBm25(
  model: Bm25Model,
  queryTokens: string[],
): Bm25Hit[] {
  const hits: Bm25Hit[] = [];
  const uniqueQueryTerms = [...new Set(queryTokens)];

  for (const [path, tf] of model.termFreqs) {
    const docLength = model.docLengths.get(path) ?? 0;
    let score = 0;
    for (const term of uniqueQueryTerms) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const df = model.docFreqs.get(term) ?? 0;
      // IDF with the +1 inside the log keeps it non-negative even for terms
      // that appear in more than half the corpus.
      const idf = Math.log(
        1 + (model.docCount - df + 0.5) / (df + 0.5),
      );
      const denom =
        freq +
        K1 * (1 - B + (B * docLength) / (model.avgDocLength || 1));
      score += idf * ((freq * (K1 + 1)) / denom);
    }
    if (score > 0) hits.push({ path, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}
