# File Tools and Text Sanitizer

File Tools are designed around a source tree and a separate output tree so transformations can be reviewed before deployment.

## Recommended workflow

**Preview → optional Backup before processing → Run → review output**

## Available workflows

Depending on the selected tool, UPM can:

- select the newest timestamped file versions
- remove supported comments
- chain latest-file selection with comment cleanup
- inventory files and find byte-identical duplicates
- apply include/exclude rules
- respect `.gitignore`
- copy supported pass-through files
- write JSON manifests and run history

## Text Sanitizer

The Text Sanitizer identifies/replaces configured Unicode/AI-style punctuation and problematic invisible characters. Preview the planned changes before writing output.

## Safety

Use **Backup before processing** for registered projects when a transformation may matter operationally. File Tools output is not automatically a deployment; review the generated tree first.
