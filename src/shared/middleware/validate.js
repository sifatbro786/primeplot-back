import { z } from 'zod';

/**
 * Request validation — the NoSQL-injection boundary (ARCHITECTURE §6.1).
 * Pass plain shapes or Zod objects; plain shapes become `.strict()` objects (unknown keys → 422).
 * Parsed values land on `req.valid.{params,query,body}` (Express 5's req.query is read-only).
 *
 *   router.post('/', validate({ body: { email: z.email() } }), controller.create)
 */
const toSchema = (s) => (s instanceof z.ZodType ? s : z.object(s).strict());

export function validate({ params, query, body } = {}) {
  const schemas = {
    params: params && toSchema(params),
    query: query && toSchema(query),
    body: body && toSchema(body),
  };
  return (req, res, next) => {
    req.valid ??= {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      // A ZodError is mapped to 422 VALIDATION_ERROR by the central error handler.
      req.valid[part] = schema.parse(req[part] ?? {});
    }
    next();
  };
}

/** Common field schemas. */
export const zid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const zemail = z.string().trim().toLowerCase().max(254).pipe(z.email('Invalid email'));
