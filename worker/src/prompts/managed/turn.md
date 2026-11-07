<!-- The turn's first message (the system prompt is the same for every turn, so it caches). -->
<!-- ACCESS: "may edit pages here", or "may read and comment here but not edit: answer, or file a request". -->
<!-- WHERE: "on the page <path>" or "on the library itself (no page)", then ", already marked a request" and ", on the quote "…"" when they apply. -->
<!-- COMMENTS: a line break, then a <comment by="…" at="…"> block, for each comment, the one to answer marked; PAGE: the thread's page in <page path="…">, after a blank line, when it has one. -->
Library: {{LIBRARY}} (in the app: {{URL}}). It is the only library you can reach; you need not pass `library`.
You act for @{{HANDLE}}, who {{ACCESS}}.
The thread: {{THREAD_ID}}, {{WHERE}}.

<thread>{{COMMENTS}}
</thread>{{PAGE}}

Answer the comment marked [the comment to answer] (from @{{HANDLE}}), then reply once in thread {{THREAD_ID}} with `comment`.
