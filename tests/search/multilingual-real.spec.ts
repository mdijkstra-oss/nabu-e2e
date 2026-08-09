import { bootedTier, expect, test } from "../helpers/fixtures"
import { hitLocator, settingsWithSearches } from "../helpers/search"

// 🔌 S2: whether passages come out per subject and in the corpus's languages
// is model output, so this runs against real providers. Real builds carry no
// test hook — assertions stay at the UI.
test(
  "a mixed-language corpus is searchable per subject in each of its own languages",
  { tag: ["@S2"] },
  async ({ page, project }) => {
    expect(bootedTier(), "stack booted in override mode; run with NABU_E2E_TIER=real").toBe("real")

    await project.seed(
      "recept-stamppot.md",
      "# Stamppot met boerenkool\n\nSnijd de boerenkool fijn en kook hem samen met de aardappelen " +
        "gaar. Stamp alles door elkaar met een scheut warme melk en een klont boter. Serveer met " +
        "een rookworst en wat mosterd erbij; een echte winterse klassieker uit de Hollandse keuken.\n"
    )
    await project.seed(
      "recept-erwtensoep.md",
      "# Erwtensoep\n\nLaat de spliterwten een nacht weken en kook ze met prei, knolselderij en " +
        "winterwortel tot een dikke soep. De lepel moet er rechtop in blijven staan, zeggen we in " +
        "Nederland. Voeg op het laatst plakjes rookworst toe.\n"
    )
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es2nl",
          title: "S2 Dutch",
          description: "Dutch cooking search",
          highlight: "hoe maak je een stevige Hollandse wintermaaltijd",
          sql: "SELECT file, text, SEMANTIC('hoe maak je een stevige Hollandse wintermaaltijd klaar') FROM files LIMIT 20",
        },
        {
          id: "search-e2es2en",
          title: "S2 English",
          description: "English interview search",
          highlight: "what do people miss about the office",
          sql: "SELECT file, text, SEMANTIC('what do remote workers say they miss about the office') FROM files LIMIT 20",
        },
      ])
    )
    await project.open(page)

    // The Dutch-subject query surfaces the Dutch recipes, in Dutch.
    await page.goto(`/project/${project.id}/search/search-e2es2nl`)
    const nlHit = hitLocator(page).filter({ hasText: /rookworst|boerenkool|spliterwten/ })
    await expect(nlHit.first()).toBeVisible({ timeout: 180_000 })

    // The English-subject query surfaces the interview corpus, not the recipes.
    await page.goto(`/project/${project.id}/search/search-e2es2en`)
    const enHit = hitLocator(page).filter({ hasText: /kitchen conversations|spontaneous conversation/ })
    await expect(enHit.first()).toBeVisible({ timeout: 180_000 })
  }
)
