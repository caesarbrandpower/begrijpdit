// ── PII-ANONIMISERING ────────────────────────────────────────────────────────
// Vervangt persoonsgegevens door placeholders vóór verzending naar de Anthropic API.
// Na het antwoord worden de originele waarden teruggeplaatst.
//
// Volgorde is bewust: specifieke patronen (IBAN, email) vóór generieke (BSN).
// Naamdetectie is best-effort via aanspreektitels; NLP is niet beschikbaar.

const PII_RULES = [
  // IBAN — NL en internationaal (2 letters + 2 cijfers + 4 alfanum + 7+ cijfers)
  {
    label: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,}\b/g,
  },
  // E-mailadres
  {
    label: 'EMAIL',
    regex: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
  },
  // Telefoonnummer — NL-formaten: 06, 0xx, +31, 0031
  {
    label: 'TELEFOON',
    regex: /(?:(?:\+31|0031)[\s\-]?0?|0)[1-9][\d\s\-]{7,9}(?=[\s,.\n\r)>\]]|$)/g,
  },
  // BSN — precies 9 aaneengesloten cijfers (na IBAN zodat IBAN-cijfers al vervangen zijn)
  {
    label: 'BSN',
    regex: /\b\d{9}\b/g,
  },
  // Postcode — bijv. "1234 AB" of "1234AB"
  {
    label: 'POSTCODE',
    regex: /\b\d{4}\s?[A-Z]{2}\b/g,
  },
  // Naam na aanspreektitel — best-effort, 1–4 naamsdelen inclusief tussenvoegsels
  {
    label: 'NAAM',
    regex: /\b(de heer|dhr\.?|mevrouw|mevr\.?|mw\.?|meneer)\s+([A-Z][a-zA-ZÀ-ÿ.\-]+(?:\s+[a-zA-ZÀ-ÿ.\-]+){0,3})/gi,
    keepPrefix: true,
  },
];

/** Registreert een waarde in de map en geeft de placeholder terug. */
function getOrCreate(map, counters, label, value) {
  for (const [ph, orig] of map) {
    if (orig === value) return ph;
  }
  const n = (counters[label] = (counters[label] || 0) + 1);
  const ph = `[${label}_${n}]`;
  map.set(ph, value);
  return ph;
}

/** Anonimiseert één tekststuk en schrijft gevonden waarden in de gedeelde map. */
function anonymiseText(text, map, counters) {
  let result = text;

  for (const rule of PII_RULES) {
    if (rule.keepPrefix) {
      result = result.replace(rule.regex, (_match, title, name) => {
        const ph = getOrCreate(map, counters, rule.label, name);
        return `${title} ${ph}`;
      });
    } else {
      result = result.replace(rule.regex, (match) =>
        getOrCreate(map, counters, rule.label, match)
      );
    }
  }

  return result;
}

/** Vervangt placeholders in tekst terug door de originele waarden. */
function restore(text, map) {
  let result = text;
  for (const [ph, original] of map) {
    result = result.split(ph).join(original);
  }
  return result;
}

/**
 * Loopt over alle user-berichten en anonimiseert tekstblokken.
 * Geeft de bewerkte berichten en een gecombineerde placeholder-map terug.
 */
function processMessages(messages) {
  const map = new Map();
  const counters = {};

  const processed = messages.map((msg) => {
    if (msg.role !== 'user') return msg;

    if (typeof msg.content === 'string') {
      return { ...msg, content: anonymiseText(msg.content, map, counters) };
    }

    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map((block) => {
        if (block.type !== 'text') return block; // PDF/afbeelding: ongewijzigd
        return { ...block, text: anonymiseText(block.text, map, counters) };
      });
      return { ...msg, content: newContent };
    }

    return msg;
  });

  return { processed, map };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const { processed: anonMessages, map } = processMessages(body.messages || []);

    if (map.size > 0) {
      console.log('[anonimisering] Vervangen waarden:', Object.fromEntries(map));
      console.log('[anonimisering] Geanonimiseerde berichten:', JSON.stringify(anonMessages, null, 2));
    } else {
      console.log('[anonimisering] Geen persoonsgegevens gevonden.');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...body, messages: anonMessages }),
    });

    const data = await response.json();

    // Placeholders terugplaatsen in het antwoord van de API
    if (map.size > 0 && Array.isArray(data.content)) {
      data.content = data.content.map((block) => {
        if (block.type !== 'text') return block;
        return { ...block, text: restore(block.text, map) };
      });
    }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'API fout' });
  }
}
