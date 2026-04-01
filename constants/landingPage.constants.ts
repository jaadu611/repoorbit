import { LucideIcon, Network, Orbit, Waypoints } from "lucide-react";

export const sectionData: {id: number, Icon: LucideIcon, badgeText: string, title: string, highlightTitle: string, description: string, imageSrc: string}[] =[
    {
        id: 1,
        Icon: Network,
        badgeText: "Phase 1: The Planner",
        title: "The Scout.",
        highlightTitle: "Manifest Analysis.",
        description: 'High-level dependency manifest analysis to find the right "Neighborhoods." RepoOrbit identifies the core architectural markers before the first line of code is indexed, ensuring a focused, efficient audit path.',
        imageSrc: "https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png",
    },
    {
        id: 2,
        Icon: Orbit,
        badgeText: "Phase 2: The Architect",
        title: "The Surveyor.",
        highlightTitle: "Missing Links.",
        description: 'Map execution traces and identify "Shadow" dependencies. The Architect flags unimplemented references—like the useAsapEffect case—ensuring no phantom logic corrupts your architectural briefings.',
        imageSrc: "https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png",
    },
    {
        id: 3,
        Icon: Waypoints,
        badgeText: "Phase 3: The Surgeon",
        title: "The Coder.",
        highlightTitle: "Surgical Synthesis.",
        description: 'Feeding high-density, importance-weighted code blocks to Gemini and DeepSeek for 100% accurate implementation audits. Stop dumping context; start performing surgical codebase operations.',
        imageSrc: "https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png",
    }
]
