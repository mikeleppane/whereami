import type { Register } from 'claude-code'

// Another plugin's band: it calls next(e) and stacks its one line above what the plugins below return.
export const register: Register = (on) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>polite band</Text>
        {below}
      </Box>
    )
  })
}
