#!/usr/bin/env node
// The entry point checks Node's version before anything else loads: on
// Node 18 and older, fmrl-mcp's own modules fail at import with an error
// that says nothing about Node, and the client only sees the server close.
import { MIN_NODE, nodeMajor, serveTooOld } from "./oldnode.js";

if (nodeMajor(process.versions.node) < MIN_NODE) serveTooOld(process.versions.node);
else await import("./start.js");
