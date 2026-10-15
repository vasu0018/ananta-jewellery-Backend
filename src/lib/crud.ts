/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Router } from "express";
import type { ZodTypeAny } from "zod";
import { notFound, pageArgs, pageMeta, param, parse, queryString } from "./http";
import { requirePerm } from "../middleware/auth";
import { logActivity } from "./audit";
import { serialize, slugify } from "./utils";

type Delegate = {
  findMany: (args?: any) => Promise<any[]>;
  findUnique: (args: any) => Promise<any>;
  count: (args?: any) => Promise<number>;
  create: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
  delete: (args: any) => Promise<any>;
};

/**
 * Registers standard list/get/create/update/delete endpoints for simple models.
 * Complex resources (products, orders...) have hand-written routes instead.
 */
export function registerCrud(
  router: Router,
  path: string,
  opts: {
    model: Delegate;
    area: string;
    entity: string;
    createSchema: ZodTypeAny;
    updateSchema?: ZodTypeAny;
    searchFields?: string[];
    orderBy?: any;
    include?: any;
    listWhere?: (req: Request) => any;
    /** Auto-generate `slug` from this field when missing */
    slugFrom?: string;
    transform?: (data: any, req: Request, id?: string) => any | Promise<any>;
    afterSave?: (row: any, req: Request) => Promise<void> | void;
    paginate?: boolean;
    readOnly?: boolean;
    noDelete?: boolean;
    noCreate?: boolean;
  },
) {
  const read = requirePerm(`${opts.area}.read`);
  const write = requirePerm(`${opts.area}.write`);

  router.get(path, read, async (req, res) => {
    const q = queryString(req, "q");
    const where = {
      ...(opts.listWhere?.(req) ?? {}),
      ...(q && opts.searchFields?.length
        ? { OR: opts.searchFields.map((f) => ({ [f]: { contains: q, mode: "insensitive" } })) }
        : {}),
    };
    if (opts.paginate) {
      const { page, limit, skip, take } = pageArgs(req.query);
      const [total, items] = await Promise.all([
        opts.model.count({ where }),
        opts.model.findMany({ where, orderBy: opts.orderBy ?? { createdAt: "desc" }, include: opts.include, skip, take }),
      ]);
      res.json(serialize({ items, meta: pageMeta(total, page, limit) }));
      return;
    }
    res.json(serialize(await opts.model.findMany({ where, orderBy: opts.orderBy ?? { createdAt: "desc" }, include: opts.include })));
  });

  router.get(`${path}/:id`, read, async (req, res) => {
    const row = await opts.model.findUnique({ where: { id: param(req, "id") }, include: opts.include });
    if (!row) throw notFound(`${opts.entity} not found`);
    res.json(serialize(row));
  });

  if (opts.readOnly) return;

  if (!opts.noCreate) {
    router.post(path, write, async (req, res) => {
      let data = parse(opts.createSchema, req.body);
      if (opts.slugFrom && !data.slug) data.slug = slugify(String(data[opts.slugFrom] ?? ""));
      if (opts.transform) data = await opts.transform(data, req);
      const row = await opts.model.create({ data, include: opts.include });
      await opts.afterSave?.(row, req);
      await logActivity(req, `${opts.entity.toLowerCase()}.create`, opts.entity, row.id, row.name ?? row.title ?? row.code ?? undefined);
      res.status(201).json(serialize(row));
    });
  }

  router.patch(`${path}/:id`, write, async (req, res) => {
    const id = param(req, "id");
    let data = parse(opts.updateSchema ?? (opts.createSchema as any).partial(), req.body);
    if (opts.transform) data = await opts.transform(data, req, id);
    const row = await opts.model.update({ where: { id }, data, include: opts.include });
    await opts.afterSave?.(row, req);
    await logActivity(req, `${opts.entity.toLowerCase()}.update`, opts.entity, id, row.name ?? row.title ?? row.code ?? undefined);
    res.json(serialize(row));
  });

  if (!opts.noDelete) {
    router.delete(`${path}/:id`, write, async (req, res) => {
      const id = param(req, "id");
      await opts.model.delete({ where: { id } });
      await logActivity(req, `${opts.entity.toLowerCase()}.delete`, opts.entity, id);
      res.json({ ok: true });
    });
  }
}
