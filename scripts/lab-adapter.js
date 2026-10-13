// Local lab only: HTTP transport with the subset of supabase-js used by repository.js.
// Production continues to use the real Supabase SDK; this file is never published.
(function (root) {
  root.makeLabClient = function (base, token) {
    const post = async body => {
      const response = await fetch(base + '/api', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': token },
        body: JSON.stringify(body),
      });
      return response.json();
    };
    return {
      rpc: (name, params) => post({ rpc: name, params }),
      from: table => {
        const spec = { table, filters: [], limit: 100 };
        const query = {
          select() { return query; },
          eq(column, value) { spec.filters.push({ column, value, kind: 'eq' }); return query; },
          in(column, value) { spec.filters.push({ column, value, kind: 'in' }); return query; },
          order(column, options) { spec.order = { column, ascending: options?.ascending === true }; return query; },
          limit(value) { spec.limit = value; return query; },
          maybeSingle() { spec.single = true; return query; },
          then(resolve, reject) { return post(spec).then(resolve, reject); },
        };
        return query;
      },
    };
  };
})(typeof window === 'undefined' ? globalThis : window);
