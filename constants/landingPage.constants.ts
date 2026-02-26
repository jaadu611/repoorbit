import { LucideIcon, Network, Orbit, Waypoints } from "lucide-react";

export const sectionData: {id: number, Icon: LucideIcon, badgeText: string, title: string, highlightTitle: string, description: string, imageSrc: string}[] =[
    {
        id: 1,
        Icon: Network,
        badgeText: "Root System",
        title: "The Root System.",
        highlightTitle: "Navigate the logic.",
        description: 'Giant monorepo got you lost? Use the Root System to pick a few key “root” folders + logical branches. Instantly know “which root does this file really belong to?” Way less mental overhead and more time for cat reels.',
        imageSrc: "https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png",
    },
    {
        id: 2,
        Icon: Orbit,
        badgeText: "Galaxy Mode",
        title: "Planet View.",
        highlightTitle: "Weight & Importance.",
        description: 'Visualize your codebase as a solar system where file size determines mass. Planets grow based on import frequency and importance, letting you instantly spot your "heavy lifter" files and critical infrastructure.',
        imageSrc: "https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png",
    },
    {
        id: 3,
        Icon: Waypoints,
        badgeText: "Dynamic Flow",
        title: "Dependency Orbit.",
        highlightTitle: "Trace the Arrows.",
        description: 'Strip away the noise and see the skeleton. Every file is connected via directional arrows, mapping the flow of data across your entire project. See exactly how one change ripples through your imports.',
        imageSrc: "https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png",
    }
]