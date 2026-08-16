import { createClient } from "contentful";

const space = import.meta.env.CONTENTFUL_SPACE_ID;
const accessToken = import.meta.env.CONTENTFUL_ACCESS_TOKEN;

if (!space) {
  throw new Error("CONTENTFUL_SPACE_ID absent du fichier .env");
}

if (!accessToken) {
  throw new Error("CONTENTFUL_ACCESS_TOKEN absent du fichier .env");
}

export const contentfulClient = createClient({
  space,
  accessToken,
});