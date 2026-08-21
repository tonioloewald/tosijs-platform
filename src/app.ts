import { tosi } from 'tosijs'
import * as fb from './firebase'
import { Page } from '../functions/shared/page'
import { getPrefetched } from './prefetched'

const loading = { source: '# Loading' } as Page

export const { app } = tosi({
  app: {
    title: '',
    subtitle: '',
    currentPage: loading,
    pages: [] as Page[],
    setPage(page: Page) {
      app.currentPage.value = page
      window.history.pushState(null, page.title, `/${page.path}`)
    },
    showSignIn: false,
    fb,
    user: {} as any,
  },
})

window.addEventListener('popstate', () => {
  const path = window.location.pathname
  const page = app.pages.value.find((page) => page.path === path.substring(1))
  app.setPage(page || loading)
})

getPrefetched('appConfig').then((config) => {
  app.title = config.title
  app.subtitle = config.subtitle
})

getPrefetched<Page>('page').then((page) => {
  app.currentPage.value = page || loading
})

getPrefetched<Array<Page>>('visiblePages').then((pages) => {
  app.pages.value = pages || []
})

fb.authStateChangeListeners.add(async () => {
  app.user = await fb.service.user.get()
})
