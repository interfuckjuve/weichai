# Services

This directory contains independently runnable production capabilities. Each
service must communicate through documented contracts and must not import GUI
components or Mock adapters.

Migration capability is language-pair and strategy specific. Java → C# is a
historical regression baseline, not the current product boundary. Consumers
must use the validated exact-route runtime capability snapshot; compiler or
adapter registration alone does not imply an executable route. Comprehensive
multi-language development does not mean every route is available. Production
V2 fails closed when a required provider, trusted Host stage, authoritative
artifact, isolated verifier, or validation record is unavailable. V1 adaptation
and the adaptation MCP server are deprecated compatibility surfaces and must
not be used as capability evidence or as fallbacks from V2.
