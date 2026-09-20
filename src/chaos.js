// Demo only: is the "bad release" simulation switched on via the URL (?chaos=1)?
export const chaosFromUrl = () =>
  new URLSearchParams(window.location.search).get('chaos') === '1';
