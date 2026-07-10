<script setup lang="ts">
// Static reference content -- no API calls needed on this page.
</script>

<template>
  <div class="max-w-3xl">
    <h2 class="text-2xl font-semibold mb-1">API Reference</h2>
    <p class="text-sm text-gray-500 mb-8">
      A small REST API backing this app. Every endpoint below except <code class="text-xs bg-gray-200 px-1 rounded">/api/config</code>
      and <code class="text-xs bg-gray-200 px-1 rounded">/api/health</code> requires an <code class="text-xs bg-gray-200 px-1 rounded">X-API-Key</code> header. The key itself is fetched by the frontend
      from <code class="text-xs bg-gray-200 px-1 rounded">/api/config</code> automatically -- you can find it in this project's
      <code class="text-xs bg-gray-200 px-1 rounded">.env</code> file if you need it for a direct call.
    </p>

    <!-- Ask AI -- the main feature, gets the deep dive -->
    <section class="mb-10">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-green-100 text-green-800 px-2 py-0.5 rounded">POST</span>
        <h3 class="text-lg font-semibold font-mono">/api/ask</h3>
      </div>
      <p class="text-sm text-gray-600 mb-4">
        Turns a plain-English question into an answer about what's in stock. This is what powers the "Ask AI" page.
      </p>

      <h4 class="text-sm font-semibold mb-2">How it works</h4>
      <ol class="list-decimal list-inside text-sm text-gray-700 space-y-1 mb-4">
        <li>Your question is sent to SumoPod (gpt-5-mini), along with a short description of the database schema -- never your actual data.</li>
        <li>The model responds with a single read-only SQL query (or a clarifying question, if what you asked is ambiguous).</li>
        <li>That query is checked -- only <code class="text-xs bg-gray-200 px-1 rounded">SELECT</code> statements against the <code class="text-xs bg-gray-200 px-1 rounded">vehicles</code> table are allowed, anything else (or any destructive keyword) is rejected outright.</li>
        <li>The query runs against the real database, and the answer is built directly from the result in plain code -- no second AI call, which is what keeps this cheap.</li>
        <li>Unless you specifically ask about one, every status (available/booked/sold) and every location is included by default, not just what's currently for sale.</li>
      </ol>

      <h4 class="text-sm font-semibold mb-2">Request</h4>
      <table class="w-full text-sm border-collapse mb-4">
        <tbody>
          <tr class="border-b border-gray-200">
            <td class="py-1.5 pr-4 font-mono text-xs text-gray-500 align-top">question</td>
            <td class="py-1.5 text-gray-700">Required. <code class="text-xs bg-gray-200 px-1 rounded">multipart/form-data</code> field -- the question in plain English.</td>
          </tr>
          <tr>
            <td class="py-1.5 pr-4 font-mono text-xs text-gray-500 align-top">X-API-Key</td>
            <td class="py-1.5 text-gray-700">Required header.</td>
          </tr>
        </tbody>
      </table>

      <h4 class="text-sm font-semibold mb-2">Example request</h4>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto mb-4">curl -X POST "http://localhost:3000/api/ask" \
  -H "X-API-Key: your-api-key" \
  -F "question=How many Hondas are in stock?"</pre>

      <h4 class="text-sm font-semibold mb-2">Example response (answered)</h4>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto mb-4">{
  "status": "answered",
  "question": "How many Hondas are in stock?",
  "sql": "SELECT brand, model_trim, license_plate, location, status, notes_raw, price_credit FROM vehicles WHERE brand = 'Honda' LIMIT 50",
  "summary": "3 vehicle(s) found:\n- Honda Freed 1.5L E PSD AT, B2905DW, at DSSM (JAKSEL), (available), Rp130.000.000\n- Honda HRV 1.5L E AT, B1500WOH, at DSSM (TANGSEL), (available), Rp175.000.000\n- Honda Mobilio 1.5L E AT, B1723FOF, at DSSM (BKS), (available), Rp115.000.000",
  "rows": [ /* the raw rows the SQL returned */ ],
  "usage": { "prompt_tokens": 210, "completion_tokens": 42, "total_tokens": 252 }
}</pre>

      <h4 class="text-sm font-semibold mb-2">Example response (needs clarification)</h4>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto mb-4">{
  "status": "needs_clarification",
  "message": "Which car are you asking about?",
  "usage": { "prompt_tokens": 195, "completion_tokens": 18, "total_tokens": 213 }
}</pre>

      <p class="text-xs text-gray-500">
        <code class="bg-gray-200 px-1 rounded">usage</code> is passed straight through from SumoPod so you can see exactly what each
        question costs -- the Ask AI page adds these up into a running session total for the same reason.
      </p>
    </section>

    <!-- Other endpoints, more compact -->
    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-gray-200 text-gray-700 px-2 py-0.5 rounded">GET</span>
        <h3 class="text-base font-semibold font-mono">/api/config</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">No auth required. Returns the API key so the frontend can authenticate its own subsequent calls.</p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl "http://localhost:3000/api/config"

{ "apiKey": "..." }</pre>
    </section>

    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-green-100 text-green-800 px-2 py-0.5 rounded">POST</span>
        <h3 class="text-base font-semibold font-mono">/api/upload</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">
        Accepts an .xlsx file (form field <code class="text-xs bg-gray-200 px-1 rounded">file</code>), parses the "Pricelist" and
        "SMR" sheets, and inserts the results into the database. Requires the usual
        <code class="text-xs bg-gray-200 px-1 rounded">X-API-Key</code> header.
      </p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl -X POST "http://localhost:3000/api/upload" \
  -H "X-API-Key: your-api-key" \
  -F "file=@inventory.xlsx"

{
  "uploadId": 3,
  "inserted": 76,
  "skipped": [
    { "sheet": "Pricelist", "row": 8, "reason": "#REF! error" }
  ]
}</pre>
    </section>

    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-gray-200 text-gray-700 px-2 py-0.5 rounded">GET</span>
        <h3 class="text-base font-semibold font-mono">/api/vehicles</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">
        Returns every row currently in the <code class="text-xs bg-gray-200 px-1 rounded">vehicles</code> table, as a plain JSON array.
        No filtering or pagination yet -- this is what the Database page fetches and filters client-side.
      </p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl "http://localhost:3000/api/vehicles" \
  -H "X-API-Key: your-api-key"

[
  { "id": 1, "license_plate": "B2905DW", "brand": "Honda", "model_trim": "Freed 1.5L E PSD AT", "status": "available", ... },
  ...
]</pre>
    </section>

    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-gray-200 text-gray-700 px-2 py-0.5 rounded">GET</span>
        <h3 class="text-base font-semibold font-mono">/api/vehicles/search</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">
        Filtered, sorted, paginated search over <code class="text-xs bg-gray-200 px-1 rounded">vehicles</code>. Supports text filters
        (brand, model_trim, color, location, ownership, source, sheet_name, reserved_by), exact filters (status, transmission),
        numeric/date/year ranges, free-text <code class="text-xs bg-gray-200 px-1 rounded">q</code>, <code class="text-xs bg-gray-200 px-1 rounded">sort_by</code>/<code class="text-xs bg-gray-200 px-1 rounded">order</code>,
        and <code class="text-xs bg-gray-200 px-1 rounded">limit</code>/<code class="text-xs bg-gray-200 px-1 rounded">offset</code>
        (default limit 100, max 500). Unrecognized query params are silently ignored.
      </p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl "http://localhost:3000/api/vehicles/search?brand=Honda&status=available&limit=50" \
  -H "X-API-Key: your-api-key"

{
  "rows": [ { "id": 1, "brand": "Honda", ... }, ... ],
  "total": 12
}</pre>
      <p class="text-xs text-gray-500">
        <code class="bg-gray-200 px-1 rounded">total</code> is the count of all rows matching the filters before
        <code class="bg-gray-200 px-1 rounded">limit</code>/<code class="bg-gray-200 px-1 rounded">offset</code> were applied, for building "showing 1-50 of 340" style pagination.
      </p>
    </section>

    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-gray-200 text-gray-700 px-2 py-0.5 rounded">GET</span>
        <span class="text-xs font-mono bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">PATCH</span>
        <span class="text-xs font-mono bg-red-100 text-red-800 px-2 py-0.5 rounded">DELETE</span>
        <h3 class="text-base font-semibold font-mono">/api/vehicles/:id</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">
        Read, edit, or remove a single vehicle. <code class="text-xs bg-gray-200 px-1 rounded">:id</code> must be an integer -- 400
        otherwise -- and 404 if no vehicle has that id.
      </p>
      <p class="text-sm text-gray-600 mb-2">
        <strong>PATCH</strong> accepts a JSON body with any of: <code class="text-xs bg-gray-200 px-1 rounded">status</code>,
        <code class="text-xs bg-gray-200 px-1 rounded">reserved_by</code>, <code class="text-xs bg-gray-200 px-1 rounded">price_cash</code>,
        <code class="text-xs bg-gray-200 px-1 rounded">price_credit</code>, <code class="text-xs bg-gray-200 px-1 rounded">max_credit_discount</code>,
        <code class="text-xs bg-gray-200 px-1 rounded">notes_raw</code>, <code class="text-xs bg-gray-200 px-1 rounded">location</code>.
        Other fields (id, vin, license_plate, upload_id, created_at, ...) are silently ignored, matching how
        <code class="text-xs bg-gray-200 px-1 rounded">/search</code> treats unrecognized query params. If nothing editable is left
        after filtering, returns 400. Sets <code class="text-xs bg-gray-200 px-1 rounded">updated_at</code> and returns the full
        updated row.
      </p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl "http://localhost:3000/api/vehicles/76" -H "X-API-Key: your-api-key"

curl -X PATCH "http://localhost:3000/api/vehicles/76" \
  -H "X-API-Key: your-api-key" -H "Content-Type: application/json" \
  -d '{ "status": "sold", "reserved_by": null }'

curl -X DELETE "http://localhost:3000/api/vehicles/76" -H "X-API-Key: your-api-key"
{ "deleted": true, "id": 76 }</pre>
    </section>

    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-gray-200 text-gray-700 px-2 py-0.5 rounded">GET</span>
        <h3 class="text-base font-semibold font-mono">/api/uploads</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">
        Upload history, most recent first. One row per past upload: id, filename, uploaded_at, rows_inserted, rows_skipped.
        Paginated the same way as <code class="text-xs bg-gray-200 px-1 rounded">/search</code> (<code class="text-xs bg-gray-200 px-1 rounded">limit</code>/<code class="text-xs bg-gray-200 px-1 rounded">offset</code>,
        default limit 100, max 500). <code class="text-xs bg-gray-200 px-1 rounded">rows_inserted</code>/<code class="text-xs bg-gray-200 px-1 rounded">rows_skipped</code>
        are <code class="text-xs bg-gray-200 px-1 rounded">null</code> for uploads made before these columns existed.
      </p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl "http://localhost:3000/api/uploads?limit=20" -H "X-API-Key: your-api-key"

[
  { "id": 3, "filename": "inventory.xlsx", "uploaded_at": "2026-07-01T09:15:00.000Z", "rows_inserted": 76, "rows_skipped": 1 },
  ...
]</pre>
    </section>

    <section>
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-mono bg-gray-200 text-gray-700 px-2 py-0.5 rounded">GET</span>
        <h3 class="text-base font-semibold font-mono">/api/health</h3>
      </div>
      <p class="text-sm text-gray-600 mb-2">
        No auth required. Runs a <code class="text-xs bg-gray-200 px-1 rounded">SELECT 1</code> against Postgres so this reflects
        real reachability, not just that Express is up. Returns 503 (not 200) if the DB check fails -- for uptime/monitoring tools.
      </p>
      <pre class="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto">curl "http://localhost:3000/api/health"

{ "status": "ok", "timestamp": "2026-07-10T12:00:00.000Z" }</pre>
    </section>
  </div>
</template>
