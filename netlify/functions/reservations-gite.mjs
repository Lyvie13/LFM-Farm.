const CONTENT_TYPE = "reservationGite";
const VALID_PUBLIC_STATUSES = new Set([
  "demandeRecue",
  "attenteAcompte",
  "confirmee",
  "indisponible",
]);

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const env = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable Netlify manquante : ${name}`);
  return value;
};

const contentfulConfig = () => ({
  space: env("CONTENTFUL_SPACE_ID"),
  environment: process.env.CONTENTFUL_ENVIRONMENT?.trim() || "master",
  token: env("CONTENTFUL_MANAGEMENT_TOKEN"),
});

const apiRequest = async (path, options = {}) => {
  const { token } = contentfulConfig();
  const response = await fetch(`https://api.contentful.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.contentful.management.v1+json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Contentful CMA", response.status, details);
    throw new Error("Contentful n’a pas accepté la demande.");
  }
  return response.json();
};

let defaultLocale;
const getDefaultLocale = async () => {
  if (process.env.CONTENTFUL_LOCALE?.trim()) return process.env.CONTENTFUL_LOCALE.trim();
  if (defaultLocale) return defaultLocale;
  const { space, environment } = contentfulConfig();
  const locales = await apiRequest(`/spaces/${space}/environments/${environment}/locales?limit=100`);
  defaultLocale = locales.items.find((locale) => locale.default)?.code || locales.items[0]?.code || "en-US";
  return defaultLocale;
};

const getEntries = async () => {
  const { space, environment } = contentfulConfig();
  return apiRequest(`/spaces/${space}/environments/${environment}/entries?content_type=${CONTENT_TYPE}&limit=1000&order=-sys.createdAt`);
};

const localValue = (field, locale) => field?.[locale];
const dateKey = (value) => (typeof value === "string" ? value.slice(0, 10) : "");
const isValidDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const toIsoDate = (value) => `${value}T00:00:00.000Z`;

const effectiveStatus = (fields, locale) => {
  const status = localValue(fields.statut, locale);
  const expiration = localValue(fields.expirationAcompte, locale);
  if (status === "attenteAcompte" && expiration && new Date(expiration) < new Date()) return "expiree";
  return status;
};

const publicPeriods = async () => {
  const [entries, locale] = await Promise.all([getEntries(), getDefaultLocale()]);
  return entries.items
    .map((entry) => {
      const status = effectiveStatus(entry.fields, locale);
      return {
        start: dateKey(localValue(entry.fields.dateArrivee, locale)),
        end: dateKey(localValue(entry.fields.dateDepart, locale)),
        status,
      };
    })
    .filter((period) => period.start && period.end && VALID_PUBLIC_STATUSES.has(period.status));
};

const cleanText = (value, maxLength) =>
  typeof value === "string" ? value.trim().replace(/[<>]/g, "").slice(0, maxLength) : "";

const integer = (value, minimum, maximum, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const overlapsBlockedPeriod = (start, end, periods) =>
  periods.some((period) =>
    ["attenteAcompte", "confirmee", "indisponible"].includes(period.status) &&
    start < period.end && end > period.start
  );

const createReservation = async (body) => {
  if (body.website) return { ignored: true };

  const dateArrivee = cleanText(body.dateArrivee, 10);
  const dateDepart = cleanText(body.dateDepart, 10);
  const prenom = cleanText(body.prenom, 80);
  const nomClient = cleanText(body.nomClient, 80);
  const email = cleanText(body.email, 160).toLowerCase();
  const telephone = cleanText(body.telephone, 30);
  const message = cleanText(body.message, 2000);

  if (!isValidDateKey(dateArrivee) || !isValidDateKey(dateDepart) || dateDepart <= dateArrivee) {
    throw Object.assign(new Error("Choisissez une date d’arrivée et une date de départ valides."), { status: 400 });
  }
  if (dateArrivee < new Date().toISOString().slice(0, 10)) {
    throw Object.assign(new Error("La date d’arrivée ne peut pas être dans le passé."), { status: 400 });
  }
  const nights = Math.round((Date.parse(`${dateDepart}T00:00:00Z`) - Date.parse(`${dateArrivee}T00:00:00Z`)) / 86400000);
  if (nights > 60) {
    throw Object.assign(new Error("Pour un séjour supérieur à 60 nuits, contactez directement LFM Farm."), { status: 400 });
  }
  if (!prenom || !nomClient || !/^\S+@\S+\.\S+$/.test(email)) {
    throw Object.assign(new Error("Renseignez votre prénom, votre nom et une adresse e-mail valide."), { status: 400 });
  }
  if (!body.consentement) {
    throw Object.assign(new Error("Vous devez accepter la politique de confidentialité."), { status: 400 });
  }

  const periods = await publicPeriods();
  if (overlapsBlockedPeriod(dateArrivee, dateDepart, periods)) {
    throw Object.assign(new Error("Ces dates viennent d’être bloquées. Choisissez une autre période ou contactez LFM Farm."), { status: 409 });
  }

  const locale = await getDefaultLocale();
  const field = (value) => ({ [locale]: value });
  const fields = {
    nomInterne: field(`Demande ${prenom} ${nomClient} — ${dateArrivee}`),
    statut: field("demandeRecue"),
    dateArrivee: field(toIsoDate(dateArrivee)),
    dateDepart: field(toIsoDate(dateDepart)),
    prenom: field(prenom),
    nomClient: field(nomClient),
    email: field(email),
    nombreAdultes: field(integer(body.nombreAdultes, 1, 10, 1)),
    nombreEnfants: field(integer(body.nombreEnfants, 0, 10, 0)),
    nombreChevaux: field(integer(body.nombreChevaux, 0, 10, 0)),
    consentement: field(true),
    rappelEnvoye: field(false),
  };
  if (telephone) fields.telephone = field(telephone);
  if (message) fields.message = field(message);

  const { space, environment } = contentfulConfig();
  const entry = await apiRequest(`/spaces/${space}/environments/${environment}/entries`, {
    method: "POST",
    headers: { "X-Contentful-Content-Type": CONTENT_TYPE },
    body: JSON.stringify({ fields }),
  });

  return { id: entry.sys.id };
};

export default async (request) => {
  try {
    if (request.method === "GET") {
      return json({ periods: await publicPeriods() });
    }
    if (request.method === "POST") {
      const requestOrigin = request.headers.get("origin");
      const currentOrigin = new URL(request.url).origin;
      if (requestOrigin && requestOrigin !== currentOrigin) return json({ message: "Origine refusée." }, 403);

      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) return json({ message: "Format de demande invalide." }, 415);
      const body = await request.json();
      const result = await createReservation(body);
      return json({ success: true, ...result }, 201);
    }
    return json({ message: "Méthode non autorisée." }, 405);
  } catch (error) {
    console.error("Réservation gîte", error);
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = status < 500 ? error.message : "Le service de réservation est momentanément indisponible.";
    return json({ success: false, message }, status);
  }
};

export const config = {
  path: "/api/reservations-gite",
};
