// Resolves the DMTF JSON schema for a resource so each property can show its
// description, units, and what an enum value means.
//
// Redfish refs come in two shapes. Versioned ones (CoolingUnit.v1_6_0.json)
// hold the real definitions. Unversioned ones
// (CoolingLoop.json#/definitions/Coolant) hold an anyOf listing each version.
// The last entry is the newest, so that's the one I use.
"use strict";

const Schema = (() => {
  const files = new Map(); // file name -> Promise<json|null>

  function loadFile(name) {
    if (!files.has(name)) {
      files.set(name, fetch(`/schemas/${name}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null));
    }
    return files.get(name);
  }

  // "#CoolingUnit.v1_6_0.CoolingUnit" -> {file: "CoolingUnit.v1_6_0.json", def: "CoolingUnit"}
  function parseType(odataType) {
    if (typeof odataType !== "string") return null;
    const t = odataType.replace(/^#/, "");
    const i = t.lastIndexOf(".");
    if (i < 0) return null;
    return { file: `${t.slice(0, i)}.json`, def: t.slice(i + 1) };
  }

  async function getDef(file, def) {
    const doc = await loadFile(file);
    const node = doc && doc.definitions && doc.definitions[def];
    return node ? { node, file } : null;
  }

  // Follow $ref / anyOf until reaching a node with properties, enum, or a type.
  async function resolve(node, baseFile, depth = 0) {
    if (!node || depth > 12) return null;
    if (node.$ref) {
      const [filePart, frag] = node.$ref.split("#");
      const file = filePart ? filePart.split("/").pop() : baseFile;
      const def = (frag || "").split("/").pop();
      if (file === "odata-v4.json") return { node: { linkOnly: true }, file };
      const hit = await getDef(file, def);
      return hit ? resolve(hit.node, hit.file, depth + 1) : null;
    }
    if (node.anyOf) {
      const refs = node.anyOf.filter(a => a.$ref && !a.$ref.includes("odata-v4.json"));
      if (refs.length) return resolve(refs[refs.length - 1], baseFile, depth + 1);
      const typed = node.anyOf.find(a => a.type && a.type !== "null");
      if (typed) return { node: typed, file: baseFile };
    }
    return { node, file: baseFile };
  }

  // Schema for the whole resource, from its @odata.type.
  async function forResource(json) {
    const t = parseType(json && json["@odata.type"]);
    if (!t) return null;
    const hit = await getDef(t.file, t.def);
    return hit ? resolve(hit.node, hit.file) : null;
  }

  // Annotation for one property of an already-resolved object schema.
  // Description and units can sit on the property or on what it points at,
  // so read the property first and fall back to the target.
  async function property(parent, key) {
    const props = parent && parent.node && parent.node.properties;
    const raw = props && props[key];
    if (!raw) return null;
    let target;
    if (raw.items) {
      target = { node: raw, file: parent.file, items: await resolve(raw.items, parent.file) };
    } else {
      target = await resolve(raw, parent.file);
      if (target && target.node.items) {
        target = { ...target, items: await resolve(target.node.items, target.file) };
      }
    }
    const t = target ? target.node : {};
    return {
      description: raw.description || t.description || "",
      longDescription: raw.longDescription || t.longDescription || "",
      units: raw.units || t.units || "",
      readonly: raw.readonly,
      deprecated: raw.deprecated || t.deprecated || "",
      versionAdded: raw.versionAdded || "",
      excerpt: raw.excerpt || "",
      target,
    };
  }

  function enumMeaning(schemaNode, value) {
    const n = schemaNode && schemaNode.node;
    if (!n || !n.enumDescriptions) return "";
    return n.enumDescriptions[value] || "";
  }

  return { forResource, property, enumMeaning, parseType };
})();
