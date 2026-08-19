# PW Decisions

Permanent cross-project decisions and standing instructions for ProjectWorkbench on PVI2.

## 2026-07-15 — STANDING: Force animations regardless of OS "reduce motion" (all web projects)

Every PW **web** project displays its animations regardless of the OS "reduce motion" preference —
that toggle is spuriously ON for RDP sessions, most VMs, and Windows "Adjust for best performance",
so visitors who never opted out otherwise see a static-looking site. Include the canonical drop-in
(one inline `<script>`, first in `<head>`) from the ProjectWorkbench repo `standards/force-motion/`:
it patches `matchMedia` for JS motion libs and strips `@media (prefers-reduced-motion: reduce)`
blocks from same-origin CSS. Never self-gate animations; never "restore" motion with a CSS `revert`
(it reverts to 0s). Apply it in every new project's first-pass build by default.

## 2026-08-19 - STANDING: ASP.NET Core shared-hosting defaults (all new ASP.NET Core sites)

James declared this universal for new ASP.NET Core sites hosted on memory-constrained shared
IIS/SmarterASP environments. New web projects must explicitly set workstation GC and Out-of-Process
hosting from the first scaffold, in the project file (or `Directory.Build.props` for a multi-project
solution):

```xml
<PropertyGroup>
  <ServerGarbageCollection>false</ServerGarbageCollection>
  <AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>
</PropertyGroup>
```

Why: the Web SDK defaults to server GC, which reserves a heap per core and is the usual reason a
shared app pool gets recycled for memory. In-process hosting runs the app inside the IIS worker
process, so one site can take the pool down with it; Out-of-Process runs Kestrel behind the ASP.NET
Core Module and keeps the memory and failure boundary at the site.

Never hand-edit the generated `*.runtimeconfig.json` or the published `web.config`. Both are build
outputs and are overwritten on the next publish; set the MSBuild properties instead.

Verification is required for both properties before a site is called done. Check the resolved
MSBuild values and the published artifacts, because they can disagree:

```bash
dotnet msbuild <Project>.csproj -getProperty:ServerGarbageCollection -getProperty:AspNetCoreHostingModel
dotnet publish -c Release -o out
grep -i '"System.GC.Server"' out/<App>.runtimeconfig.json   # expect false
grep -i 'hostingModel'       out/web.config                 # expect OutOfProcess (case can vary by SDK)
```

The published values must literally read `"System.GC.Server": false` and a `hostingModel` of
OutOfProcess. A `true` value, or the key missing altogether, both mean server GC is still in effect.
The `web.config` attribute is written from the MSBuild property verbatim, so its case follows what
you set; the unset in-process default publishes as `hostingModel="inprocess"`.

Verified against the .NET SDK 10.0.111 `dotnet new web` template on 2026-08-19: unset, it resolves
to `ServerGarbageCollection=true` / `AspNetCoreHostingModel=inprocess` and publishes
`"System.GC.Server": true` with `hostingModel="inprocess"`, which is exactly the configuration this
decision exists to prevent.

A different setting requires measured evidence from a dedicated or high-throughput workload plus the
reason documented here.
