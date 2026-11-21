import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://docs.oakgreen.cc',
  integrations: [
    starlight({
      title: 'oakgreen',
      description: 'Run coding agents against a GitHub repository, with GitHub as the source of truth.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/oakgreencc/monorepo' }],
      editLink: { baseUrl: 'https://github.com/oakgreencc/monorepo/edit/main/docs/' },
      sidebar: [
        { label: 'Tutorials', items: [{ autogenerate: { directory: 'tutorials' } }] },
        { label: 'How-to guides', items: [{ autogenerate: { directory: 'how-to' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Explanation', items: [{ autogenerate: { directory: 'explanation' } }] },
      ],
    }),
  ],
})
