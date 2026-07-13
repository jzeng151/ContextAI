export const safeReturnTo = (value: string | null, origin: string) => {
  try {
    const url = new URL(value || "/", origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
};
