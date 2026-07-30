function buildMongoUri(baseUri, dbName) {
  const [beforeQuery, query] = baseUri.split('?');
  const schemeEnd = beforeQuery.indexOf('://') + 3;
  const lastSlash = beforeQuery.lastIndexOf('/');
  const withoutDb = lastSlash >= schemeEnd ? beforeQuery.slice(0, lastSlash) : beforeQuery;
  return `${withoutDb}/${dbName}${query ? '?' + query : ''}`;
}

module.exports = { buildMongoUri };
