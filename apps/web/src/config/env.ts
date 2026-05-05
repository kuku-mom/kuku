import { prodRelease } from "./prod_release";

interface WebEnv {
  api: {
    baseUrl: string;
  };
  mocking: {
    enabled: boolean;
  };
}

const defaultApiBaseUrl = import.meta.env.PROD ? prodRelease.apiBaseUrl : "http://localhost:8080";

export const env: WebEnv = {
  api: {
    baseUrl: import.meta.env.PUBLIC_KUKU_API_BASE_URL ?? defaultApiBaseUrl,
  },
  mocking: {
    enabled: import.meta.env.PUBLIC_KUKU_API_MOCKING === "1",
  },
};
