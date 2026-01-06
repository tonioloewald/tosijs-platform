import { Component, elements } from 'tosijs'

const { iframe } = elements

export class YoutubePlayer extends Component {
  src = 'https://www.youtube-nocookie.com/embed/y7K-lk6MnEE?si=ja-4Mcr-JKruHbKM'
  allowfullscreen = true
  allow =
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'

  styleNode = Component.StyleNode({
    ':host': {
      display: 'inline-block',
      minWidth: '300px',
      minHeight: '200px',
    },
  })

  constructor() {
    super()
    this.initAttributes('src', 'allowfullscreen', 'allow')
  }

  content = iframe({
    part: 'player',
    title: 'Youtube Video Player v2',
    frameborder: '0',
    style: {
      height: '100%',
      width: '100%',
    },
  })

  render(): void {
    super.render()

    const { player } = this.parts as { player: HTMLIFrameElement }

    if (this.allowfullscreen) {
      player.setAttribute('allowfullscreen', '')
    } else {
      player.removeAttribute('allowfullscreen')
    }
    player.src = this.src
  }
}

export const youtubePlayer = YoutubePlayer.elementCreator({
  tag: 'youtube-player',
})
