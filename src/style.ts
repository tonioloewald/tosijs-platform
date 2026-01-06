import {
  XinStyleSheet,
  bind,
  invertLuminance,
  css,
  vars,
  elements,
  Color,
  tosi,
} from 'tosijs'
const { style } = elements

const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@100;200;300;400;500;600;700;800;900&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap'
const BRAND_COLOR = Color.fromCss('rgb(8, 131, 88)')
const SHADE_COLOR = Color.fromCss('#ecffeb')
const TEXT_COLOR = Color.fromCss('#222222')
const BG_COLOR = Color.fromCss('#fdfdfd')
const INPUT_BG = Color.fromCss('white')

const MODE_MAP = { system: null, dark: null, light: null }
export type Mode = keyof typeof MODE_MAP
const MODES = Object.keys(MODE_MAP) as Mode[]

export const { theme } = tosi({
  theme: {
    get mode() {
      let mode = localStorage.getItem('ui-theme') as Mode
      return MODES.includes(mode) ? mode : MODES[0]
    },
    set mode(newMode: Mode) {
      localStorage.setItem('ui-theme', newMode)
    },
  },
})

bind(document.body, theme.mode, {
  toDOM(elt, value) {
    switch (value.valueOf()) {
      case 'dark':
        elt.classList.add('darkmode')
        break
      case 'light':
        elt.classList.remove('darkmode')
        break
      default:
        const autoSetting = getComputedStyle(document.body).getPropertyValue(
          '--darkmode'
        )
        elt.classList.toggle('darkmode', autoSetting === 'true')
    }
  },
})

const cssVars = {
  _font: "'Roboto Slab', Serif",
  _codeFont: "'Space Mono', monospace",
  _fontSize: 16,
  _codeFontSize: 14,
  _lineHeight: 25,
  _pad: 16,
  _readableWidth: '40em',
  _listWidth: '14em',
  _gap: vars.pad50,
  _roundedRadius: vars.pad25,
  _textColor: TEXT_COLOR.html,
  _brandColor: BRAND_COLOR.html,
  _paleBrandColor: BRAND_COLOR.saturate(0.5).opacity(0.1).html,
  _linkColor: BRAND_COLOR.saturate(1).darken(0.1).html,
  _itemSpacing: vars.pad50,
  _background: BG_COLOR.html,
  _panelBg: BG_COLOR.darken(0.025).html,
  _bodyBg: BG_COLOR.darken(0.05).html,
  _inputBg: INPUT_BG.html,
  _buttonBg: SHADE_COLOR.opacity(0.25).html,
  _hoverBg: SHADE_COLOR.opacity(0.75).html,
  _activeBg: SHADE_COLOR.html,
  _lightBorderColor: BRAND_COLOR.opacity(0.2).html,
  _borderColor: BRAND_COLOR.opacity(0.4).html,
  _lightBorderShadow: `0 0 0 1px ${vars.lightBorderColor}`,
  _borderShadow: `0 0 0 1px ${vars.borderColor}`,
  _zShadow: `0 2px 8px ${vars.lightBorderColor}`,
  _toolbarHeight: `calc(${vars.lineHeight} + ${vars.pad})`,
  _placeHolderOpacity: 0.5,
  _border: `0.5px solid ${vars.borderColor}`,
  _lightBorder: `0.5px solid ${vars.lightBorderColor}`,
  _vh: '100vh',
  _touchSize: '48px',
  // menus
  _menuItemHoverBg: vars.hoverBg,
  _menuItemActiveBg: vars.activeBg,
  _menuItemColor: vars.brandColor,
  _menuItemActiveColor: vars.brandColor,
  _menuBg: vars.panelBg,
  _menuItemIconColor: vars.brandColor,
  _scrollThumbColor: '#0004',
  _scrollBarColor: '#0002',
}

const brandColors = {
  _brandColor: BRAND_COLOR.html,
  _brandTextColor: SHADE_COLOR.html,
}

const codeVars = {
  _codeColor: '#fbfbfb',
  _codeBg: BRAND_COLOR.darken(0.75).saturate(0.5).html,
}

const rules: XinStyleSheet = {
  '@import': FONTS_URL,

  body: {
    ...cssVars,
    ...brandColors,
    ...codeVars,
    fontFamily: vars.font,
    background: vars.bodyBg,
    color: vars.textColor,
    margin: 0,
    fontSize: vars.fontSize,
    lineHeight: vars.lineHeight,
    accentColor: vars.brandColor,
  },
  '@media screen and (max-width:512px)': {
    'header, footer': {
      _pad: '8px',
      _touchSize: '32px',
      _fontSize: '13px',
      _lineHeight: '19px',
    },
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    margin: 'auto',
    maxWidth: `calc(${vars.readableWidth} + ${vars.listWidth})`,
    background: vars.background,
  },
  '*': {
    boxSizing: 'border-box',
    scrollbarColor: `${vars.scrollThumbColor} ${vars.scrollBarColor}`,
    scrollbarWidth: 'thin',
  },
  '@media (prefers-color-scheme: dark)': {
    body: {
      _darkmode: 'true',
    },
  },
  '.darkmode': {
    ...invertLuminance(cssVars),
    ...invertLuminance(codeVars),
    _brandTextColor: '#222',
    _zShadow: `inset 0 0 0 2px ${vars.lightBorderColor}`,
  },
  h1: {
    color: vars.brandColor,
    fontSize: vars.fontSize200,
    lineHeight: vars.lineHeight175,
    margin: `${vars.pad200} 0 ${vars.gap}`,
  },
  p: {
    margin: `0 0 ${vars.gap}`,
  },
  'button, input': {
    background: vars.buttonBg,
    color: vars.textColor,
    padding: `0 ${vars.pad75}`,
    border: 0,
    fontSize: vars.fontSize,
    lineHeight: `calc(${vars.fontSize} + ${vars.pad})`,
    boxShadow: vars.lightBorderShadow,
  },
  a: {
    color: vars.linkColor,
    opacity: 0.8,
  },
  'a:visited': {
    opacity: 0.7,
  },
  'a:hover': {
    opacity: 0.9,
  },
  'a:active': {
    opacity: 1,
  },
  button: {
    borderRadius: vars.roundedRadius,
  },
  'button:hover': {
    background: vars.hoverBg,
  },
  'button:active': {
    background: vars.activeBg,
  },
  input: {
    borderRadius: vars.roundedRadius50,
  },
  'input[type="range"]': {
    boxShadow: 'none',
  },
  'input[type="search"]': {
    borderRadius: vars.pad50,
  },
  'button:hover, .clickable:hover': {
    background: vars.hoverBg,
  },
  'button:active, .clickable:active': {
    background: vars.activeBg,
  },
  label: {
    display: 'inline-flex',
    gap: vars.gap,
    alignItems: 'center',
  },
  ':focus': {
    outline: 'none',
  },
  // layout
  '.row, .column': {
    display: 'flex',
  },
  '.row': {
    alignItems: 'center',
  },
  '.column': {
    flexDirection: 'column',
  },
  '.responsive-row': {
    display: 'flex',
  },
  '.responsive-stack': {
    flex: `0 0 ${vars.baseWidth}`,
    overflow: 'hidden',
  },
  '@media screen and (max-width: 800px)': {
    '.responsive-row': {
      flexDirection: 'column',
    },
    '.responsive-stack': {
      flex: '0 0 auto',
    },
  },
  '.stack, .responsive-stack': {
    display: 'flex',
    flexDirection: 'column',
  },
  '.rigid': {
    flex: '0 0 auto',
  },
  '.elastic': {
    flex: '1 1 auto',
  },
  // padding and margin
  '.nopad': {
    padding: 0,
  },
  '.nomargin': {
    margin: 0,
  },
  '.crop': {
    overflow: 'hidden',
  },
  // textwrap
  '.nowrap': {
    whiteSpace: 'nowrap',
  },
  '.ellipsis': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.padded': {
    padding: vars.pad,
    gap: vars.pad,
  },
  figure: {
    padding: 0,
    margin: `${vars.pad} 0`,
  },
  'figcaption, .caption': {
    padding: `${vars.pad50} ${vars.pad}`,
    fontSize: '80%',
  },
  img: {
    maxWidth: '100%',
  },
  // text
  '.readable': {
    maxWidth: vars.readableWidth,
  },
  '.center-justify': {
    textAlign: 'center',
    justifyContent: 'center',
  },
  // blog
  '.post-summary img': {
    width: '100%',
    height: '160px',
    objectFit: 'cover',
    marginRight: vars.pad,
  },
  'xin-blog-post img': {
    margin: `${vars.pad} 0`,
  },
  'xin-blog-post blockquote': {
    background: vars.paleBrandColor,
    margin: `${vars.pad} 0`,
    padding: `${vars.pad} ${vars.pad200}`,
    borderRadius: vars.spacing25,
  },
  'xin-blog-post pre': {
    padding: vars.pad,
    fontSize: vars.codeFontSize,
    color: vars.codeColor,
    background: vars.codeBg,
    lineHeight: '1.2',
    overflowX: 'auto',
    borderRadius: vars.spacing25,
  },
  '.post-summary > .row': {
    gap: vars.pad,
  },
  '@media screen and (max-width:480px)': {
    '.post-summary > .row:nth-child(2)': {
      flexDirection: 'column',
    },
    '.post-summary > .row:nth-child(2) img': {
      height: 'auto',
      width: '100%',
    },
  },
  '.post-summary > .row > *': {
    position: 'relative',
  },
  '.post-summary > .row > :nth-child(1)': {
    flex: '0 0 40%',
  },
  '.post-summary > .row > :nth-child(2)': {
    flex: '0 1 60%',
  },
  // loading
  '.loading': {
    display: 'none !important',
    transition: 'opacity 0.5s ease-out',
    opacity: 0,
  },
  header: {
    borderBottom: vars.lightBorder,
  },
  'header .logo': {
    height: vars.touchSize,
    width: vars.touchSize,
  },
  'header h2': {
    fontSize: vars.fontSize175,
    lineHeight: vars.lineHeight110,
  },
  'header h3': {
    fontSize: vars.fontSize,
    fontWeight: '200',
    lineHeight: vars.lineHeight90,
  },
  footer: {
    borderTop: vars.lightBorder,
  },
  nav: {
    background: vars.panelBg,
  },
  // icons
  '[class*="icon-"]': {
    fill: vars.brandColor,
    height: '16px',
    pointerEvents: 'none',
    verticalAlign: 'middle',
  },
  '.iconic': {
    background: 'transparent',
    height: vars.touchSize,
    lineHeight: vars.touchSize,
    width: vars.touchSize,
    flex: '0 0 auto',
    padding: 0,
    textAlign: 'center',
    boxShadow: 'none',
    borderRadius: vars.roundedRadius50,
  },
  // xin-tabs
  'xin-tabs::part(tabs)': {
    overflowX: 'auto',
  },
  // xin-float, xin-menu
  'xin-float, .xin-menu': {
    boxShadow: vars.zShadow,
    borderRadius: vars.roundedRadius200,
    overflow: 'hidden',
  },
  '.xin-menu-item:disabled': {
    pointerEvents: 'none',
    opacity: '0.5',
  },
  '.xin-menu-item-checked': {
    background: vars.hoverBg,
  },
  'xin-example': {
    margin: `${vars.spacing} 0`,
  },
  'xin-blog xin-example [part="exampleWidgets"]': {
    _widgetBg: vars.buttonBg,
    _widgetColor: vars.brandColor,
    opacity: 0.75,
  },
  'xin-blog xin-example [part="exampleWidgets"]:hover': {
    opacity: 1,
  },
  'xin-blog xin-carousel': {
    _carouselButtonColor: vars.scrollBarColor,
    _carouselDotCurrentColor: vars.scrollThumbColor,
  },
  'xin-example .preview.preview': {
    background: vars.codeColor,
  },
  'button *': {
    pointerEvents: 'none',
  },
  'tosi-dialog header': {
    border: 'none',
  },
  'tosi-dialog footer': {
    border: 'none',
  },
}

document.head.append(style({ id: 'base-style' }, css(rules)))

// adapted from https://css-tricks.com/the-trick-to-viewport-units-on-mobile/
const setTrueHeight = () => {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`)
}
setTrueHeight()
window.addEventListener('resize', setTrueHeight)
