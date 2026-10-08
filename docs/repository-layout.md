# One repository for Notework AI

The [hpsonghyun/notework-ai repository](https://github.com/hpsonghyun/notework-ai) contains the source, tests, website and shared assets for the 0.4.8 desktop alpha.

```text
notework-ai/
  src/                   Plugin implementation
  tests/                 Functional and synthetic UI checks
  scripts/               Build, review, packaging and local development helpers
  assets/                Conceptual brand illustration, logos and synthetic UI captures
  docs/
    index.html           Self-contained English website
    community.html       Self-contained community-listing preview
    getting-started.md    Setup and supported workflows
    provider-boundaries.md Connections, costs and data flows
    community-listing.md  Submission copy draft
    mobile-quickstart.md  Mobile development status and recovery boundaries
    roadmap.md           Implemented scope and future direction
  README.md              English product and development guide
  README.ko.md            Stable redirect to current English documentation
  SECURITY.md            Credential, process and private-data boundaries
```

GitHub Pages serves `/docs` from this same repository when hosting is enabled, at `https://hpsonghyun.github.io/notework-ai/`. The older personal-site repository is a historical copy rather than a second development target.

HTML files contain their own CSS, scripts and embedded imagery, with no external font, analytics or script dependency. Source links require network access; private prerelease reviews also require repository permission. Website illustrations and screenshots use invented notes and synthetic provider state. They do not contain runtime vault records or account credentials.

Credentials, CLI authentication files, local indexes and recovery copies, saved conversations, real notes and local QA output must remain outside public source/release assets. Historical design/prototype files are development references rather than current product instructions.

The graph uses an independently implemented Canvas projection. Its star positions are a navigation layout; they do not encode a calibrated similarity distance. Camera/picking conventions can resemble other graph tools without incorporating their code or artwork.
