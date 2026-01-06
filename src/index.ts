import { elements, vars, bindings, tosi } from 'tosijs'
import { icons, popMenu } from 'tosijs-ui'
import './style'
import { blog } from './blog'
import { xinPage } from './page'
import './tosi-esm'
import { theme } from './style'
import { app } from './app'
import * as fb from './firebase'
import { roleManager } from './role-manager'

// Helper to check if user has admin+ role
const isAdmin = (): boolean => {
  const roles = app.user?.roles || []
  return (
    roles.includes('admin') ||
    roles.includes('developer') ||
    roles.includes('owner')
  )
}

const { a, h2, h3, img, button, div, header, main, footer } = elements

declare global {
  interface Window {
    app: typeof app
    blog: typeof blog
    fb: typeof fb
    tosi: typeof tosi
  }
}

window.app = app
window.blog = blog
window.fb = fb
window.tosi = tosi

bindings.loading = {
  toDOM(element, truthy) {
    const isLoading =
      !(typeof truthy === 'object' && truthy.valueOf()) && !truthy
    element.classList.toggle('loading', isLoading)
  },
}

// comment
document.body.append(
  main(
    {
      bindLoading: blog.currentPost.content,
    },
    header(
      { class: 'row padded', style: { paddingRight: 0 } },
      a(
        {
          href: '/',
          style: {
            flex: `0 0 ${vars.touchSize}`,
            // dunno why this is needed but without there's a Chrome rendering issue
            maxHeight: vars.touchSize,
          },
        },
        img({
          alt: 'favicon',
          src: '/stored/public/favicon.svg',
          class: 'logo',
        })
      ),
      div(
        { class: 'stack elastic crop' },
        h2({ class: 'nopad nomargin', bindText: app.title }),
        h3({
          class: 'nopad nomargin nowrap ellipsis',
          bindText: app.subtitle,
        })
      ),
      div({ class: 'elastic' }),
      button(
        {
          title: 'Menu',
          class: 'iconic',
          onClick(event: Event) {
            const target = event.target as HTMLButtonElement
            popMenu({
              target,
              menuItems: [
                ...app.pages.xinValue.map((page) => ({
                  icon: page.icon,
                  caption: page.title,
                  action() {
                    app.setPage(page)
                  },
                })),
                ...(app.pages.length > 0 ? [null] : []),
                {
                  caption: 'Theme',
                  menuItems: [
                    {
                      icon: 'sun',
                      caption: 'Light',
                      checked: () => theme.mode.valueOf() === 'light',
                      action() {
                        theme.mode.xinValue = 'light'
                      },
                    },
                    {
                      icon: 'moon',
                      caption: 'Dark',
                      checked: () => theme.mode.valueOf() === 'dark',
                      action() {
                        theme.mode.xinValue = 'dark'
                      },
                    },
                    null,
                    {
                      icon: 'settings',
                      caption: 'System',
                      checked: () => theme.mode.valueOf() === 'system',
                      action() {
                        theme.mode.xinValue = 'system'
                      },
                    },
                  ],
                },
                // Admin tools menu (for admin, developer, owner roles)
                ...(isAdmin()
                  ? [
                      null,
                      {
                        icon: 'users',
                        caption: 'Role Manager',
                        action() {
                          // Only add if not already open
                          if (!document.querySelector('role-manager')) {
                            document.body.append(roleManager())
                          }
                        },
                      },
                    ]
                  : []),
                // Sign in/out
                ...(app.showSignIn.valueOf() || app.fb.getFirebaseUser()
                  ? [
                      null,
                      app.fb.getFirebaseUser()
                        ? {
                            icon: 'logOut',
                            caption: 'Sign Out',
                            action() {
                              app.fb.userSignout()
                            },
                          }
                        : {
                            icon: 'logIn',
                            caption: 'Sign In',
                            action() {
                              app.fb.signinWithGoogle()
                            },
                          },
                    ]
                  : []),
              ],
            })
          },
        },
        icons.chevronDown()
      )
    ),
    xinPage({
      page: app.currentPage,
    }),
    footer(
      {
        class: 'responsive-row padded center-justify',
        style: { position: 'relative' },
      },
      `Copyright ©2003-${new Date().getFullYear()} Tonio Loewald`,
      a(
        {
          title: 'Sandra Bullock is awesome!',
          style: {
            opacity: 0.05,
            textDecoration: 'none',
            position: 'absolute',
            top: 0,
            right: 0,
            padding: vars.pad,
            cursor: 'default',
          },
          onClick() {
            app.showSignIn.xinValue = true
            document.body.querySelector('header')!.scrollIntoView()
          },
        },
        'π'
      )
    )
  )
)
