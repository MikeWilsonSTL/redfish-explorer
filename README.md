# Redfish Explorer
<img width="1424" height="764" alt="image" src="https://github.com/user-attachments/assets/11d8503f-9d7e-4f5b-b0d4-3ce4d0dbb837" />
<br>
I wanted a Redfish visualizer to bolster my study efforts, especially around the
liquid cooling fields, and I couldn't find a good option, so I made one. It's a
local, clickable explorer for Redfish services that helps you get a feel for how
the Redfish tree fits together. It also works as a query builder: every resource
has a curl line you can copy and run against the mock or a real BMC. It's meant
for reading and learning, not for operating hardware, though it also works against
live hardware when you run it locally.

You can check out a live demo here: https://redfish.mikewilsonstl.com

## What it does

- **Tree** on the left: collection members and sub-resources, loaded as you
  expand them. A red or amber dot means that resource reports Critical or
  Warning health (its own or its rollup), so faults stand out while you browse.
- **Properties** view: every value next to its DMTF schema description, its
  units, and what the spec says an enum value means. For example,
  `CriticalReactionType: ShutDown` shows "Forcefully shut down the device".
  Hover over a description to see the normative "shall" text. Italic keys aren't in
  the schema (OEM properties, annotations).
- **Raw JSON** view, where every `/redfish/v1/...` string is a link.
- Every `@odata.id`, `DataSourceUri` and `OriginOfCondition` is a link. The URL
  hash tracks where you are, so back/forward and bookmarks work.
- It flags any resource whose `@odata.id` doesn't match where it was served.
- A **curl** line above each resource gives you the request to copy. Send it to
  the mock or to a real BMC (host, `-k`, credentials from `$RF_USER`/`$RF_PASS`),
  add `$select`, `$expand`, `$filter`, `$top` and `$skip`, and click any
  property name to pipe the result through `jq` for that path.

## The mock endpoint

Each resource is also plain JSON at `/rf/<source>/redfish/v1/...`, on the live
demo as well as locally, so you can try queries against a mockup before you
point them at hardware:

```bash
curl -s https://redfish.mikewilsonstl.com/rf/public-cooling-unit/redfish/v1/Chassis/CDU | jq .Status
```

Copy the URL from the curl line, not the browser's address bar. The address
bar holds a `#/...` route, and curl never sends the part after `#`, so you get
the page's HTML.

It's read-only, and the static demo ignores query parameters (`$select` and so
on return the whole resource; a real BMC applies them). A missing resource
returns a Redfish error body with status 404. The `@odata.id` links in responses are
`/redfish/v1/...` without the `/rf/<source>` prefix, so add it when you
follow them by hand. Tools that expect `/redfish/v1` at the host root
(redfishtool, python-redfish-library) won't work against it. DMTF's
[Redfish-Mockup-Server](https://github.com/DMTF/Redfish-Mockup-Server) is
the one to use for those.

## Run it

```bash
scripts/fetch-dmtf.sh        # once: DMTF mockups + JSON schemas into vendor/ (~280 MB)
python3 server.py            # http://127.0.0.1:8000/
```

It's Python 3.10+ standard library and plain browser JS. No build step and no
dependencies.

The source picker lists every DMTF mockup. I put the two liquid-cooling ones
first:

- `public-cooling-unit`: a rack CDU under `ThermalEquipment/CDUs/1` with pumps,
  filters, reservoirs, primary/secondary coolant connectors and leak detection,
  plus `Chassis/CDU` sensors and leak detectors. Pump 2 is failed in this
  mockup, so you can follow the health rollup and `Status.Conditions` →
  `OriginOfCondition` from end to end.
- `public-liquid-cooled-server`: the server side, with `CoolantConnectors` and
  `Pumps` under `Chassis/1U/ThermalSubsystem`.

## Pointing it at a real BMC

```bash
REDFISH_PASSWORD=... python3 server.py --target https://10.0.0.5 --user admin --insecure
```

A "Live" source shows up in the picker. If `REDFISH_PASSWORD` isn't set, it
prompts for the password.

The server proxies **GET requests only**. Your browser never talks to the BMC
directly. That avoids CORS errors and self-signed certificate warnings, and it
means nothing in the explorer can change state on the hardware. Auth is basic
auth on every request, with no session.

It binds to 127.0.0.1 by default. If you bind it to 0.0.0.0 with credentials
loaded, anyone on your network can read your BMC through it.

## Layout

```
server.py               routes: /, /static/*, /api/sources, /schemas/<file>, /rf/<source>/redfish/v1/...
static/schema.js        @odata.type -> DMTF JSON schema; follows $ref/anyOf to the newest version
static/app.js           tree, property view, raw view, hash routing
scripts/fetch-dmtf.sh   sparse checkout of DMTF/Redfish-Publications (mockups, json-schema)
scripts/check-odata-ids.py   lists mockup resources whose @odata.id is wrong
```

How schemas get resolved: a versioned type like `#Pump.v1_2_0.Pump` loads that
exact file. Unversioned refs like `CoolingLoop.json#/definitions/Coolant` are
an `anyOf` over every version, and I take the last (newest) one. The catch is
that against a live service running an older version, a description can mention
a property that service doesn't support yet.

## What I found

The explorer kept flagging resources whose `@odata.id` didn't match where they
were served, so I wrote `scripts/check-odata-ids.py` to list them all. **The
DMTF mockups have 21 `@odata.id` copy-paste errors** across 7 mockups
(Redfish-Publications `fa6d23d`, 2026-10-13).

There's one in the liquid-cooling material: `Chassis/CDU/Sensors/SecondaryHeatLoad`
is a copy of `PrimaryHeatLoad`. It declares that resource's `@odata.id`, `Id`
and `Name`, so the mockup has no real secondary heat-load reading. I may open
an issue or PR upstream for this.

## What I'd like to add

I'd like to make the curl line more useful for building and debugging queries.
I want the demo to stay as a static site, so both of these would run in the
browser:

- **Query preview.** Apply `$select`, `$top`/`$skip`, `$expand` and a basic
  `$filter` to the mockup in the browser, and show the result next to the
  curl command. It would be labeled as a preview of what a BMC would return,
  since the static mock can't evaluate queries itself.
- **PATCH and Action dry run.** Write a request body and check it against
  the DMTF schema already loaded for that resource: read-only properties,
  invalid enum values, wrong types and unknown properties. Then get the matching
  `curl -X PATCH -H 'Content-Type: application/json' -d '...'`. A static host
  can't accept writes, so the checking has to happen in the browser.

Doing it for real (queries evaluated on the server, writes, links at the host
root) would take some code running on the server (a Netlify Edge Function or
similar), and then the demo stops being a static site. I'm not sure that's
worth it yet.

Other ideas, in no particular order:

- Search across a source by property name or value.
- Diff two resources, or the same path in two sources (mockup vs. live BMC).
- Session auth (`SessionService`) and `$expand` support for live services.
- A cooling-loop diagram built from the `CoolingLoop` / `CoolantConnector`
  links.
