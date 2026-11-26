// `orca plugin check` renders the panel once per scenario with the worker on a fresh host. The
// worker reads Orca through its CLI; where none answers, the panel shows the failed read.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  firstRun: { storage: { locale: 'en' } },
  korean: { storage: { locale: 'ko' } }
})
