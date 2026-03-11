<script setup lang="ts">
import ForumsForumPost from './ForumPost.vue'

const props = defineProps<{
  posts: Array<{
    id: number
    parentId?: number | null
    title?: string | null
    textHtml?: string | null
    createdByName?: string | null
    createdByWikidotId?: number | null
    createdByType?: string | null
    createdAt?: string | null
    editedAt?: string | null
    isDeleted?: boolean
  }>
}>()

interface TreeNode {
  post: typeof props.posts[0]
  children: TreeNode[]
  depth: number
}

const tree = computed(() => {
  const postsArray = props.posts || []
  const postMap = new Map<number, TreeNode>()
  const roots: TreeNode[] = []

  // Create nodes
  for (const post of postsArray) {
    postMap.set(post.id, { post, children: [], depth: 0 })
  }

  // Build tree
  for (const post of postsArray) {
    const node = postMap.get(post.id)!
    if (post.parentId && postMap.has(post.parentId)) {
      const parent = postMap.get(post.parentId)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
})

// Flatten tree for rendering (DFS order with depth)
function flattenTree(nodes: TreeNode[]): Array<{ post: typeof props.posts[0]; depth: number }> {
  const result: Array<{ post: typeof props.posts[0]; depth: number }> = []
  const stack = [...nodes].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    result.push({ post: node.post, depth: node.depth })
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i])
    }
  }
  return result
}

const flatPosts = computed(() => flattenTree(tree.value))
</script>

<template>
  <div class="space-y-2">
    <ForumsForumPost
      v-for="item in flatPosts"
      :key="item.post.id"
      :post="item.post"
      :depth="item.depth"
    />
  </div>
</template>
